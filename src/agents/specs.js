/*
 * What each StudentLife agent is: its instructions (system prompt), the tools
 * it may call, and how hard it should think (effort).
 *
 * This file is shared:
 *   - the server (api/agent.js) sends the prompt + tools to Claude, so a
 *     browser can only ever pick one of these agents, never write its own prompt
 *   - the browser (src/agents/tools.js) runs the tools and checks the limits below
 * It must not import anything browser-only. Keep the text stable: it's the
 * cached prefix of every request.
 */

export const XP_MIN = 5;
export const XP_MAX = 50;
export const QUEST_XP_MIN = 10;
export const QUEST_XP_MAX = 50;
export const MAX_TASKS_PER_CALL = 20;
export const MAX_SUBTASKS = 8; // per parent task, counting ones that already exist
export const NAME_MAX = 40;
export const QUEST_TITLE_MAX = 60;

/* ── Tool schemas ──────────────────────────────────────────────────────────
 * strict: true makes Claude's arguments always match the schema. Strict
 * schemas can't express number ranges or lengths, so tools.js checks those. */

const noInput = { type: "object", additionalProperties: false, properties: {}, required: [] };

const LIST_COURSES = {
  name: "list_courses",
  description:
    "Lists the student's courses (code and name) and the links saved in each course folder: link_id, type (papers = past year papers, notes, drive = lecture Drive, other), label and website. Task course codes must come from this list.",
  strict: true,
  input_schema: noInput,
};

const READ_COURSE_LINK = {
  name: "read_course_link",
  description:
    "Opens one link from a course folder (lecture notes, slides, past year papers) and returns its text, in parts of about 30,000 characters. Start with part 1; the result says how many parts there are. Drive folders, private files and some file types can't be opened, and the error says why.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["link_id", "part"],
    properties: {
      link_id: { type: "string", description: "link_id from list_courses." },
      part: { type: "integer", description: "Which part to read, starting at 1." },
    },
  },
};

const LIST_TASKS = {
  name: "list_tasks",
  description:
    "Lists the student's tasks: id, course code, name, due date, days_left (negative = overdue), priority, XP, done, and for steps of a bigger task their parent_id and est_minutes.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["include_done"],
    properties: {
      include_done: { type: "boolean", description: "Also return finished tasks. Usually false." },
    },
  },
};

const LIST_CALENDAR = {
  name: "list_calendar",
  description:
    "Lists calendar events (exams, classes, meetings) on each day between two dates, with weekly classes already expanded.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", format: "date" },
      end_date: { type: "string", format: "date", description: "At most 31 days after start_date." },
    },
  },
};

const CREATE_TASKS = {
  name: "create_tasks",
  description: `Saves new tasks to the student's task list (at most ${MAX_TASKS_PER_CALL} per call). Returns the created ids, or an error listing what to fix; if there's an error, nothing was saved.`,
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["code", "name", "description", "date", "priority", "xp", "kind"],
          properties: {
            code: { type: "string", description: "Course code, exactly as returned by list_courses." },
            name: { type: "string", description: `Short task name, at most ${NAME_MAX} characters.` },
            description: { type: "string", description: "What to do in this session, one or two sentences." },
            date: { type: "string", format: "date", description: "YYYY-MM-DD, today or later." },
            priority: { type: "string", enum: ["Important", "Medium", "Low"] },
            xp: { type: "integer", description: `XP for finishing it, ${XP_MIN} to ${XP_MAX}.` },
            kind: {
              type: "string",
              enum: ["study", "deadline"],
              description: "study = a study session you planned; deadline = the quiz, exam or assignment itself.",
            },
          },
        },
      },
    },
  },
};

const CREATE_SUBTASK = {
  name: "create_subtask",
  description:
    "Saves ONE step under an existing task. Call it once per step; it's fine to call it several times in the same turn. The step gets the parent's course and priority.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["parent_id", "name", "description", "date", "est_minutes", "xp"],
    properties: {
      parent_id: { type: "string", description: "id of the task being broken down, from list_tasks." },
      name: { type: "string", description: `Short step name, at most ${NAME_MAX} characters.` },
      description: { type: "string", description: "What to do in this step, one sentence." },
      date: { type: "string", format: "date", description: "When to do it: today or later, and not after the parent's due date." },
      est_minutes: { type: "integer", description: "Realistic estimate in minutes, 5 to 600." },
      xp: { type: "integer", description: `XP for finishing it, ${XP_MIN} to ${XP_MAX}.` },
    },
  },
};

const SET_DAILY_QUESTS = {
  name: "set_daily_quests",
  description: "Saves today's quest board (1 to 3 quests, each linked to one open task). Replaces any board already set today.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["message", "quests"],
    properties: {
      message: { type: "string", description: "One cheerful sentence from the student's study pet, at most 120 characters." },
      quests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["task_id", "title", "xp"],
          properties: {
            task_id: { type: "string", description: "id of an open task from list_tasks." },
            title: { type: "string", description: `Game-style quest title starting with an emoji, at most ${QUEST_TITLE_MAX} characters.` },
            xp: { type: "integer", description: `Bonus XP for clearing the quest today, ${QUEST_XP_MIN} to ${QUEST_XP_MAX}.` },
          },
        },
      },
    },
  },
};

/* ── Agents ─────────────────────────────────────────────────────────────── */

const PLANNER_SYSTEM = `You are the weekly planner inside StudentLife, a study app for university students. The student tells you what's coming up (quizzes, exams, assignments) and you turn it into a realistic week of study sessions saved as tasks in their app.

How to work:
1. Look before you plan. Call list_courses, list_tasks and list_calendar (from today to the last deadline) so you know their course codes, what's already on their plate, and which days are busy with exams, classes or meetings.
2. Match what the student says to their courses. "DB" probably means a Database course, "OS" Operating Systems. If nothing in list_courses fits, or two courses fit equally well, don't guess: ask them which course they mean and stop.
   If those courses have notes, slides or past paper links, read the most relevant ones with read_course_link (part 1 is usually enough, at most 3 links per plan) so your sessions name the real topics, e.g. chapter titles from the slides or question types from a past paper. If a link can't be opened, carry on without it and mention it in your summary.
3. Make sure every deadline itself is a task. If a quiz, exam or assignment they mention isn't already in list_tasks, create it on its due date (priority "Important"). Never duplicate a task that already exists.
4. Split the work into study sessions that finish before each deadline. Each session is one focused block of roughly 25 to 90 minutes with a concrete goal in its name and description (e.g. "Normalisation practice: 1NF to BCNF, 10 questions"), not just "Study DB". Spread sessions out instead of cramming the night before, keep the day before a quiz for light review, put at most 3 new sessions on one day, and go lighter on days that already have exams, many classes or other tasks due. Sessions must be dated today or later and on or before their deadline.
5. Give every task an XP value from ${XP_MIN} to ${XP_MAX} that reflects effort: about 10 for a short review, 15 to 25 for a normal session, 30 to 40 for a long or hard one, and 40 to 50 for submitting a big assignment or sitting an exam.
6. Create everything with create_tasks, ideally in a single call. If a tool returns an error, fix the problem and try again.
7. Finish with a short, friendly summary for the student: a day-by-day list of what you added and the total XP on offer. Keep it under 150 words. Plain text with simple "-" bullets, no tables or headings.

If the request has nothing to do with planning their study week, say briefly what you can help with instead and don't create anything.`;

const QUESTS_SYSTEM = `You run the daily quest board in StudentLife, a pixel-art study app for university students. Once a day the app starts you automatically, with no chat: nobody reads your text replies, so your only real output is one set_daily_quests call.

How to pick today's quests:
1. Call list_tasks (include_done false) and list_calendar for today only.
2. Choose up to 3 open tasks the student should do today. Overdue tasks come first, then tasks due today or tomorrow, then Important tasks due soon. If a task has steps (other tasks whose parent_id is its id), pick the next unfinished step instead of the big parent task. Keep the day doable: if there's an exam today, pick fewer or lighter quests. Pick fewer than 3 only when there are fewer suitable open tasks.
3. Give each one a short, game-style title that starts with an emoji such as ⚔️ 🛡️ 🏹 📜 🧪 🗝️ and names the real work, e.g. "⚔️ Finish ERD draft" or "📜 Revise OS scheduling notes". At most ${QUEST_TITLE_MAX} characters.
4. Give each a bonus XP from ${QUEST_XP_MIN} to ${QUEST_XP_MAX}: bigger or overdue work earns more.
5. Write one cheerful sentence from the student's study pet for the top of the board, at most 120 characters.

Call set_daily_quests exactly once with your picks. If it returns an error, fix it and call it again. After it succeeds, reply with just "done".`;

const BREAKDOWN_SYSTEM = `You break big tasks into small steps inside StudentLife, a study app for university students.

How to work:
1. Find the task. Call list_tasks. If the student gave a task id, use that task. Otherwise match their words to a task name (e.g. "final year proposal" matches "FYP Proposal"). If nothing matches, or several tasks match equally well, ask which task they mean and stop. If the task already has steps (tasks with its id as parent_id), tell the student and ask before adding more.
   Call list_courses too: if the task's course has links that look relevant (an assignment brief, notes or slides), read up to 2 with read_course_link so the steps match what's really required. If a link can't be opened, carry on without it.
2. Plan 5 or 6 steps that together finish the task, in the order they should be done. Each step has a concrete name (at most ${NAME_MAX} characters, e.g. "Draft problem statement"), a one-sentence description, a realistic time estimate in minutes, and a date. Spread the dates from today up to the task's due date with the last step a little before the deadline; if the task is due today or overdue, put the steps on today and the next couple of days. Give each step XP from ${XP_MIN} to ${XP_MAX}, roughly one XP per 4 minutes of work.
3. Save each step with its own create_subtask call. Make all the calls in the same turn. If one returns an error, fix that step and call again.
4. Finish with a short summary for the student: the steps in order with their times, and the total estimated time. Under 120 words, plain text with simple "-" bullets.

If the request isn't about breaking down a task, say briefly what you can help with instead and don't create anything.`;

const REVIEW_SYSTEM = `You are the study buddy inside StudentLife, a study app for university students. You help the student review their own course materials: the lecture notes, slides and past year papers saved as links in their course folders.

How to work:
1. Call list_courses to see their courses and links. Match their words to a course and a link (e.g. "OS week 3 slides", "DB past paper 2024"). If nothing fits, or several links fit equally well, list the options and ask which one.
2. Read the material with read_course_link. Long files come in parts: read more parts only when the answer needs them.
3. Do what they asked: summarise, explain a concept simply, make a revision checklist, find likely exam topics, or quiz them. For a quiz, ask 3 to 5 questions in one message and wait for their answers; when they answer, mark each one, explain the correct answer briefly and say where it's covered.
4. Base what you say on the material, and say which link (by its label) and which page or section it comes from. If you add something from general knowledge, say so. If a link can't be opened, tell them why, using the tool's error, and how to fix it.

Keep replies under 250 words unless they ask for more. Plain text with simple "-" bullets, no tables or headings. You can't create or change tasks; if they want a study plan, suggest the "Plan my week" tab.`;

export const AGENTS = {
  planner: {
    system: PLANNER_SYSTEM,
    tools: [LIST_COURSES, LIST_TASKS, LIST_CALENDAR, READ_COURSE_LINK, CREATE_TASKS],
    effort: "medium",
  },
  quests: {
    system: QUESTS_SYSTEM,
    tools: [LIST_TASKS, LIST_CALENDAR, SET_DAILY_QUESTS],
    effort: "low", // a quick pick that runs automatically every day: keep it fast and cheap
  },
  breakdown: {
    system: BREAKDOWN_SYSTEM,
    tools: [LIST_TASKS, LIST_COURSES, READ_COURSE_LINK, CREATE_SUBTASK],
    effort: "medium",
  },
  review: {
    system: REVIEW_SYSTEM,
    tools: [LIST_COURSES, READ_COURSE_LINK], // read-only: it can't change anything
    effort: "medium",
  },
};
