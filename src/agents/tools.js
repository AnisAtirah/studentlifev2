import { fromKey, occursOn, toKey } from "../dateUtils.js";
import {
  AGENTS, MAX_SUBTASKS, MAX_TASKS_PER_CALL, NAME_MAX,
  QUEST_TITLE_MAX, QUEST_XP_MAX, QUEST_XP_MIN, XP_MAX, XP_MIN,
} from "./specs.js";

/*
 * The code behind each tool Claude can call. It runs in the browser.
 *
 * `store` does the actual Firestore work, so this file can be tested offline:
 *   store.read(name)        -> Promise<items>   ("tasks", "courses", "events")
 *   store.addTasks(list)    -> Promise<ids>
 *   store.saveQuests(board) -> Promise          (quest board on the profile)
 *   store.readLink(courseId, linkId, part) -> Promise<{ kind, title, part, parts, text }>
 *
 * Every tool returns { content, isError?, created?, quests? }:
 *   content  - the text Claude reads as the tool result
 *   isError  - tells Claude the call failed so it can fix it and retry
 *   created / quests - what changed, so the UI can show it
 *
 * Claude's tool input is untrusted: every limit is checked here before
 * anything is saved, even though strict schemas already fix the shape.
 */

const MAX_PLAN_DAYS = 60;
const MAX_CALENDAR_DAYS = 31;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s) => typeof s === "string" && DATE_RE.test(s) && toKey(fromKey(s)) === s;
const addDays = (key, n) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
};
const daysBetween = (from, to) => Math.round((fromKey(to) - fromKey(from)) / 86400000);
const isWholeIn = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const cleanText = (s, max) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const taskKey = (code, name, date) => `${code}|${(name || "").trim().toLowerCase()}|${date}`;

/* Progress label for the UI while a tool runs. */
export function describeToolCall(name, input) {
  switch (name) {
    case "list_courses": return "Checking your courses";
    case "read_course_link": return `Reading your course notes${input?.part > 1 ? ` (part ${input.part})` : ""}`;
    case "list_tasks": return "Reading your tasks";
    case "list_calendar": return "Looking at your calendar";
    case "create_tasks": {
      const n = Array.isArray(input?.tasks) ? input.tasks.length : 0;
      return `Saving ${n} task${n === 1 ? "" : "s"}`;
    }
    case "create_subtask": return `Adding step: ${cleanText(input?.name, NAME_MAX) || "…"}`;
    case "set_daily_quests": return "Pinning quests to the board";
    default: return "Working";
  }
}

/* Checks one task for create_tasks. Returns [cleanTask, problems]. */
function checkPlannedTask(t, i, { courseCodes, today, existing }) {
  const where = `tasks[${i}]`;
  if (!t || typeof t !== "object") return [null, [`${where} is not an object.`]];
  const problems = [];

  const name = typeof t.name === "string" ? t.name.trim() : "";
  if (!name) problems.push(`${where}.name is empty.`);
  if (name.length > NAME_MAX) problems.push(`${where}.name is longer than ${NAME_MAX} characters.`);
  if (!courseCodes.has(t.code)) {
    problems.push(`${where}.code "${t.code}" isn't one of the student's courses (${[...courseCodes].join(", ") || "none"}).`);
  }
  if (!isRealDate(t.date)) problems.push(`${where}.date "${t.date}" isn't a real YYYY-MM-DD date.`);
  else if (t.date < today) problems.push(`${where}.date ${t.date} is in the past (today is ${today}).`);
  else if (t.date > addDays(today, MAX_PLAN_DAYS)) problems.push(`${where}.date ${t.date} is more than ${MAX_PLAN_DAYS} days away.`);
  if (!["Important", "Medium", "Low"].includes(t.priority)) problems.push(`${where}.priority is invalid.`);
  if (!isWholeIn(t.xp, XP_MIN, XP_MAX)) problems.push(`${where}.xp must be a whole number from ${XP_MIN} to ${XP_MAX}.`);
  if (!["study", "deadline"].includes(t.kind)) problems.push(`${where}.kind must be "study" or "deadline".`);

  const key = taskKey(t.code, name, t.date);
  if (existing.has(key)) problems.push(`${where} duplicates a task that already exists ("${name}" on ${t.date}).`);
  existing.add(key);

  return [{
    code: t.code, name, description: cleanText(t.description, 500) || "No description",
    link: "", date: t.date, priority: t.priority, xp: t.xp, kind: t.kind,
  }, problems];
}

/* Every tool, by name. Each agent only gets the ones its spec lists. */
const TOOLS = {
  async list_courses({ store }) {
    const courses = await store.read("courses");
    const site = (url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    return {
      content: JSON.stringify(courses.map((c) => ({
        code: c.code,
        name: c.name,
        links: (c.links || []).map((l) => ({ link_id: `${c.id}:${l.id}`, type: l.type, label: l.label, site: site(l.url) })),
      }))),
    };
  },

  /* Opens a saved course link. The server fetches it; we only pass which link. */
  async read_course_link({ store }, input) {
    const [courseId, linkId] = String(input.link_id || "").split(":");
    const courses = await store.read("courses");
    const course = courses.find((c) => c.id === courseId);
    const link = course?.links?.find((l) => l.id === linkId);
    if (!link) return { isError: true, content: `No link has link_id "${input.link_id}". Use a link_id from list_courses.` };
    const part = Number.isInteger(input.part) && input.part > 0 ? input.part : 1;
    try {
      const r = await store.readLink(courseId, linkId, part);
      const header = `${course.code} · ${link.label} (${r.kind}${r.title ? `, "${r.title}"` : ""}) · part ${r.part} of ${r.parts}`;
      return { content: `${header}\n\n${r.text}`, read: { courseCode: course.code, label: link.label } };
    } catch (err) {
      return { isError: true, content: `Couldn't open "${link.label}": ${err.message}` };
    }
  },

  async list_tasks({ store, today }, input) {
    const tasks = await store.read("tasks");
    const list = tasks
      .filter((t) => input.include_done || !t.done)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        description: (t.description || "").slice(0, 200),
        date: t.date,
        days_left: isRealDate(t.date) ? daysBetween(today, t.date) : null,
        priority: t.priority,
        xp: t.xp ?? 10,
        done: !!t.done,
        ...(t.parentId ? { parent_id: t.parentId } : {}),
        ...(t.estMinutes ? { est_minutes: t.estMinutes } : {}),
      }));
    return { content: JSON.stringify(list) };
  },

  async list_calendar({ store }, input) {
    const { start_date: start, end_date: end } = input;
    if (!isRealDate(start) || !isRealDate(end) || end < start) {
      return { isError: true, content: "start_date and end_date must be YYYY-MM-DD dates with end_date on or after start_date." };
    }
    if (end > addDays(start, MAX_CALENDAR_DAYS)) {
      return { isError: true, content: `Ask for at most ${MAX_CALENDAR_DAYS} days at a time.` };
    }
    const events = await store.read("events");
    const days = [];
    for (let key = start; key <= end; key = addDays(key, 1)) {
      const onDay = events
        .filter((ev) => occursOn(ev, key))
        .map((ev) => ({ kind: ev.kind, title: ev.title, course: ev.courseCode || "", time: ev.time || "" }))
        .sort((a, b) => a.time.localeCompare(b.time));
      days.push({ date: key, weekday: fromKey(key).toLocaleDateString("en-GB", { weekday: "short" }), events: onDay });
    }
    return { content: JSON.stringify(days) };
  },

  /* Weekly planner: many tasks in one all-or-nothing batch. */
  async create_tasks({ store, today, planId }, input) {
    const list = input.tasks;
    if (!Array.isArray(list) || list.length === 0) return { isError: true, content: "tasks must be a non-empty array." };
    if (list.length > MAX_TASKS_PER_CALL) {
      return { isError: true, content: `At most ${MAX_TASKS_PER_CALL} tasks per call; split them into several calls.` };
    }
    const [courses, tasks] = await Promise.all([store.read("courses"), store.read("tasks")]);
    const ctx = {
      courseCodes: new Set(courses.map((c) => c.code)),
      today,
      existing: new Set(tasks.filter((t) => !t.done).map((t) => taskKey(t.code, t.name, t.date))),
    };
    const clean = [];
    const problems = [];
    list.forEach((t, i) => {
      const [task, p] = checkPlannedTask(t, i, ctx);
      problems.push(...p);
      if (task) clean.push({ ...task, planId });
    });
    if (problems.length) {
      return { isError: true, content: `Nothing was saved. Fix these and call create_tasks again:\n- ${problems.join("\n- ")}` };
    }
    const ids = await store.addTasks(clean);
    const created = clean.map((t, i) => ({ id: ids[i], ...t }));
    return { content: JSON.stringify({ saved: created.length, ids }), created };
  },

  /* Task breakdown: one step per call; Claude calls it 5-6 times. */
  async create_subtask({ store, today, planId }, input) {
    const tasks = await store.read("tasks");
    const parent = tasks.find((t) => t.id === input.parent_id);
    if (!parent) return { isError: true, content: `No task has id "${input.parent_id}". Use an id from list_tasks.` };
    if (parent.parentId) return { isError: true, content: "That task is already a step of another task. Break down its parent instead." };
    if (parent.done) return { isError: true, content: "That task is already done." };

    const siblings = tasks.filter((t) => t.parentId === parent.id);
    const problems = [];
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) problems.push("name is empty.");
    if (name.length > NAME_MAX) problems.push(`name is longer than ${NAME_MAX} characters.`);
    if (siblings.some((s) => (s.name || "").trim().toLowerCase() === name.toLowerCase())) {
      problems.push(`a step called "${name}" already exists for this task.`);
    }
    if (siblings.length >= MAX_SUBTASKS) problems.push(`this task already has ${siblings.length} steps (the limit is ${MAX_SUBTASKS}).`);

    // Steps go between today and the deadline; if the deadline has passed, within the next two weeks.
    const latest = isRealDate(parent.date) && parent.date >= today ? parent.date : addDays(today, 14);
    if (!isRealDate(input.date)) problems.push(`date "${input.date}" isn't a real YYYY-MM-DD date.`);
    else if (input.date < today) problems.push(`date ${input.date} is in the past (today is ${today}).`);
    else if (input.date > latest) problems.push(`date ${input.date} is after ${latest}, the latest allowed for this task.`);
    if (!isWholeIn(input.est_minutes, 5, 600)) problems.push("est_minutes must be a whole number from 5 to 600.");
    if (!isWholeIn(input.xp, XP_MIN, XP_MAX)) problems.push(`xp must be a whole number from ${XP_MIN} to ${XP_MAX}.`);
    if (problems.length) return { isError: true, content: `Not saved: ${problems.join(" ")}` };

    const step = {
      code: parent.code,
      name,
      description: cleanText(input.description, 500) || "No description",
      link: "",
      date: input.date,
      priority: parent.priority || "Medium",
      xp: input.xp,
      estMinutes: input.est_minutes,
      parentId: parent.id,
      kind: "subtask",
      planId,
    };
    const [id] = await store.addTasks([step]);
    return { content: JSON.stringify({ saved: true, id, step_number: siblings.length + 1 }), created: [{ id, ...step }] };
  },

  /* Daily quest board: links 1-3 open tasks to bonus XP for today. */
  async set_daily_quests({ store, today }, input) {
    const picks = input.quests;
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > 3) {
      return { isError: true, content: "quests must have 1 to 3 items." };
    }
    const tasks = await store.read("tasks");
    const open = new Map(tasks.filter((t) => !t.done).map((t) => [t.id, t]));
    const problems = [];
    const seen = new Set();
    picks.forEach((q, i) => {
      if (!open.has(q.task_id)) problems.push(`quests[${i}].task_id "${q.task_id}" isn't an open task.`);
      if (seen.has(q.task_id)) problems.push(`quests[${i}] repeats a task.`);
      seen.add(q.task_id);
      const title = typeof q.title === "string" ? q.title.trim() : "";
      if (!title || title.length > QUEST_TITLE_MAX) problems.push(`quests[${i}].title must be 1 to ${QUEST_TITLE_MAX} characters.`);
      if (!isWholeIn(q.xp, QUEST_XP_MIN, QUEST_XP_MAX)) problems.push(`quests[${i}].xp must be a whole number from ${QUEST_XP_MIN} to ${QUEST_XP_MAX}.`);
    });
    if (problems.length) return { isError: true, content: `Board not saved:\n- ${problems.join("\n- ")}` };

    const board = {
      date: today,
      status: "ready",
      message: cleanText(input.message, 120),
      quests: picks.map((q) => ({ taskId: q.task_id, title: q.title.trim(), xp: q.xp, done: false })),
    };
    await store.saveQuests(board);
    return { content: JSON.stringify({ saved: true, quests: board.quests.length }), quests: board };
  },
};

/*
 * Builds the runTool function for one agent run. Only the tools in that
 * agent's spec can run, even if the model asks for another one.
 */
export function createToolbox({ agent, store, planId = null, today = () => toKey(new Date()) }) {
  const allowed = new Set(AGENTS[agent].tools.map((t) => t.name));
  return async function runTool(name, input = {}) {
    if (!allowed.has(name) || !TOOLS[name]) return { isError: true, content: `Unknown tool "${name}".` };
    return TOOLS[name]({ store, planId, today: today() }, input || {});
  };
}
