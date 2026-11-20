import { fromKey, toKey } from "../dateUtils.js";
import { createToolbox, describeToolCall } from "./tools.js";

/*
 * The agent loop, shared by every StudentLife agent.
 *
 *   1. send the conversation to Claude (through /api/agent)
 *   2. if Claude asks for tools, run them here and append the results
 *   3. repeat until Claude answers without asking for tools
 *
 * The conversation is append-only: Claude's replies are stored exactly as
 * received, because they carry thinking blocks that must come back unchanged.
 */

const MAX_ROUNDS = 10;

const replyText = (content) =>
  content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();

/*
 *   callModel(messages)   -> Promise<{ content, stop_reason }>
 *   runTool(name, input)  -> Promise<{ content, isError?, created?, quests?, read? }>
 *   onStep(label)         -> progress for the UI
 * Returns { messages, reply, created, reads, quests, canContinue, model }. When canContinue
 * is false the conversation can't take a follow-up message.
 */
export async function runAgent({ messages, callModel, runTool, onStep = () => {}, maxRounds = MAX_ROUNDS }) {
  let convo = messages;
  const created = [];
  const reads = []; // course links the agent opened, to show the student its sources
  let quests = null;
  let model = null; // the model that answered last (the server may fall back to another one)
  const done = (reply, canContinue) => ({ messages: convo, created, reads, quests, reply, canContinue, model });

  for (let round = 0; round < maxRounds; round++) {
    onStep(round === 0 ? "Thinking" : "Planning");
    let response;
    try {
      response = await callModel(convo);
    } catch (err) {
      // Anything already saved stays saved; report it instead of losing it.
      if (!created.length && !quests) throw err;
      return done(`I saved part of the work, then lost the connection (${err.message}). Check your tasks.`, false);
    }
    const { content, stop_reason } = response;
    if (response.model) model = response.model;
    convo = [...convo, { role: "assistant", content }];

    if (stop_reason === "refusal") return done("Sorry, I can't help with that one. Try asking differently.", false);
    if (stop_reason === "max_tokens") return done("That got too long to finish. Try asking for less at once.", false);

    const toolUses = content.filter((b) => b.type === "tool_use");
    if (stop_reason !== "tool_use" || toolUses.length === 0) return done(replyText(content) || "Done!", true);

    // Run the tools one by one, then send every result back in a single message.
    const results = [];
    for (const call of toolUses) {
      onStep(describeToolCall(call.name, call.input));
      let out;
      try {
        out = await runTool(call.name, call.input);
      } catch (err) {
        console.error(`Tool ${call.name} failed`, err);
        out = { isError: true, content: `The app couldn't run ${call.name}: ${err.message || "unknown error"}.` };
      }
      if (out.created) created.push(...out.created);
      if (out.quests) quests = out.quests;
      if (out.read && !reads.some((r) => r.label === out.read.label && r.courseCode === out.read.courseCode)) reads.push(out.read);
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    convo = [...convo, { role: "user", content: results }];
  }

  return done(
    created.length ? "I saved part of the work but ran out of steps. Check your tasks." : "I couldn't finish this time. Try again with a shorter request.",
    false
  );
}

/* First message of a conversation: today's date goes here, not in the cached system prompt. */
export function firstMessage(text, now = new Date()) {
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long" });
  return { role: "user", content: `Today is ${weekday}, ${toKey(now)}.\n\n${text.trim()}` };
}

/*
 * Rebuilds a conversation from a saved chat, so an old chat can be continued.
 * History only keeps the visible text, so tool results and thinking are gone;
 * the agent reads the student's data again if it needs it. The first message
 * keeps the date the chat started, and the next message says today's date if
 * the day has changed, so "Friday" in the old messages still means the right day.
 */
export function chatToMessages(chat, startedOn, nextText, now = new Date()) {
  const messages = chat.map((m, i) => {
    if (m.from === "you") return i === 0 ? firstMessage(m.text, fromKey(startedOn)) : { role: "user", content: m.text };
    const sources = m.reads?.length ? `

(Links I read: ${m.reads.map((r) => `${r.courseCode} · ${r.label}`).join(", ")})` : "";
    return { role: "assistant", content: (m.text || "Done!") + sources };
  });
  const today = toKey(now);
  const prefix = today === startedOn ? "" : `Today is now ${now.toLocaleDateString("en-GB", { weekday: "long" })}, ${today}.

`;
  return [...messages, { role: "user", content: prefix + nextText.trim() }];
}

/* Calls the server function as the signed-in student. */
export async function callAgentApi(agent, messages, getIdToken, model) {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getIdToken()}` },
    body: JSON.stringify({ agent, messages, ...(model ? { model } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The assistant isn't reachable (${res.status}).`);
  return data;
}

/* Asks the server to open one of the student's saved course links. */
export async function callLinkApi(courseId, linkId, part, getIdToken) {
  const res = await fetch("/api/link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getIdToken()}` },
    body: JSON.stringify({ courseId, linkId, part }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The link reader isn't reachable (${res.status}).`);
  return data;
}

/*
 * Daily quest board: an agent with no chat. The app calls this on open; the
 * "message" is written by the app, not the student. Returns the saved board,
 * or null if the agent never saved one.
 */
export async function runQuestAgent({ store, callModel, now = new Date() }) {
  const runTool = createToolbox({ agent: "quests", store, today: () => toKey(now) });
  let result = await runAgent({
    messages: [firstMessage("Pick today's quests from my open tasks.", now)],
    callModel,
    runTool,
  });
  // tool_choice "auto" doesn't guarantee a call, so check and nudge once.
  if (!result.quests && result.canContinue) {
    result = await runAgent({
      messages: [...result.messages, { role: "user", content: "You didn't save the board. Call set_daily_quests now." }],
      callModel,
      runTool,
      maxRounds: 3,
    });
  }
  return result.quests;
}
