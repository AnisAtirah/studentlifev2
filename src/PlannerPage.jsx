import { useEffect, useMemo, useRef, useState } from "react";
import { auth } from "./firebase";
import { CHAT_HISTORY_LIMIT, addTasks, deleteChat, deleteTasks, readCollection, saveChat, useChats } from "./db";
import { fromKey, todayKey } from "./dateUtils";
import { callAgentApi, callLinkApi, chatToMessages, firstMessage, runAgent } from "./agents/runAgent";
import { createToolbox } from "./agents/tools";
import { GEMINI_MODELS, getChosenModel, modelLabel, setChosenModel } from "./agents/models";

/* The three chat agents on this page. */
const MODES = {
  planner: {
    tab: "📅 Plan my week",
    hint: "Tell me what's coming up. I'll check your tasks and calendar, split the work into study sessions, and add them to your list with XP for each one.",
    examples: [
      "I have a DB quiz Friday and an OS assignment due Monday.",
      "Midterm for Data Structures next Wednesday. Help me revise.",
      "Plan my week around my lab report and the group project draft.",
    ],
    placeholder: "e.g. I have a DB quiz Friday and an OS assignment due Monday.",
    button: "PLAN MY WEEK",
    sideTitle: "This plan",
  },
  breakdown: {
    tab: "🪓 Break down a task",
    hint: "Name a big task and I'll split it into 5 or 6 steps with time estimates, dates and XP. You can also use “Break into steps” on any task on Home.",
    examples: [
      "Break down my final year proposal",
      "Split my lab report into steps",
      "Break down the group project draft",
    ],
    placeholder: "e.g. Break down my final year proposal",
    button: "BREAK IT DOWN",
    sideTitle: "New steps",
  },
  review: {
    tab: "📚 Review my notes",
    hint: "I'll open the notes, slides and past papers saved in your course folders, then summarise them, explain a topic, or quiz you. Google files need sharing set to “Anyone with the link”.",
    examples: [
      "Summarise my OS lecture slides",
      "Quiz me on Database normalisation",
      "What topics come up most in my past year papers?",
    ],
    placeholder: "e.g. Quiz me on my Data Structures notes",
    button: "START REVIEW",
    sideTitle: "",
  },
};

const newRunId = () => `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const dayLabel = (key) => fromKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const SAVED_TEXT_MAX = 20000; // per message, keeps a chat well under Firestore's 1 MB document limit
const toSaved = (m) => ({
  from: m.from,
  text: m.text.slice(0, SAVED_TEXT_MAX),
  ...(m.reads?.length ? { reads: m.reads } : {}),
  ...(m.model ? { model: m.model } : {}),
});
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

/*
 * One chat with one agent. Remounted (fresh state) for every new or reopened chat.
 * `saved` is a chat from history, or null for a new one.
 */
function AgentChat({ uid, agent, tasks, onFlash, autoSend, saved, onNew, model }) {
  const mode = MODES[agent];
  const [input, setInput] = useState("");
  const [chat, setChat] = useState(saved?.chat || []); // what's shown: { from: "you" | "agent", text, reads? }
  const [steps, setSteps] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canContinue, setCanContinue] = useState(saved?.canContinue ?? true);
  const [created, setCreated] = useState(() => (saved?.createdIds || []).map((id) => ({ id })));
  const messagesRef = useRef([]); // the conversation sent to Claude (append-only); empty for a reopened chat
  const runIdRef = useRef(saved?.id || newRunId()); // also the chat's id in history
  const startedOnRef = useRef(saved?.startedOn || null);
  const isNewRef = useRef(!saved);
  const sentAutoRef = useRef(null);

  const started = chat.length > 0;
  // A Gemini chat stays on the model that started it (its hidden reasoning only works there)
  const chatModel = chat.find((m) => m.model)?.model;
  const otherModel = chatModel && chatModel.startsWith("gemini") && chatModel !== model;

  const send = async (text) => {
    const clean = text.trim();
    if (!clean || busy) return;
    setError("");
    setBusy(true);
    setSteps([]);
    setInput("");
    const asked = [...chat, { from: "you", text: clean }];
    setChat(asked);

    // Live chat: keep appending. Reopened chat: rebuild it from the saved text. New chat: start with today's date.
    let messages;
    if (messagesRef.current.length) messages = [...messagesRef.current, { role: "user", content: clean }];
    else if (chat.length) messages = chatToMessages(chat, startedOnRef.current, clean);
    else {
      startedOnRef.current = todayKey();
      messages = [firstMessage(clean)];
    }
    const getIdToken = () => auth.currentUser.getIdToken();
    const store = {
      read: (name) => readCollection(uid, name),
      addTasks: (list) => addTasks(uid, list),
      readLink: (courseId, linkId, part) => callLinkApi(courseId, linkId, part, getIdToken),
    };
    try {
      const result = await runAgent({
        messages,
        callModel: (messages) => callAgentApi(agent, messages, getIdToken, model),
        runTool: createToolbox({ agent, store, planId: runIdRef.current }),
        onStep: (label) => setSteps((s) => (s[s.length - 1] === label ? s : [...s, label])),
      });
      messagesRef.current = result.messages;
      setCanContinue(result.canContinue);
      const answered = [...asked, { from: "agent", text: result.reply, reads: result.reads, model: result.model }];
      setChat(answered);
      const allCreated = [...created, ...result.created];
      setCreated(allCreated);

      // Save to history. A failed save doesn't stop the chat.
      const isNew = isNewRef.current;
      isNewRef.current = false;
      saveChat(uid, runIdRef.current, {
        agent,
        title: answered[0].text.slice(0, 80),
        startedOn: startedOnRef.current,
        canContinue: result.canContinue,
        chat: answered.map(toSaved),
        createdIds: allCreated.map((t) => t.id),
      }, isNew).catch((err) => console.error("Couldn't save chat history", err));

      if (result.created.length) {
        const xp = result.created.reduce((sum, t) => sum + t.xp, 0);
        const what = agent === "breakdown" ? "steps" : "tasks";
        onFlash(`Added ${result.created.length} ${what} · ${xp} XP up for grabs ✨`);
      }
    } catch (err) {
      console.error("Agent failed", err);
      // Nothing was added to the conversation, so the student can just try again.
      setError(err.message || "Couldn't finish. Try again.");
      setChat(chat);
      setInput(clean);
    } finally {
      setBusy(false);
    }
  };

  // "Break into steps" on Home opens this page with a ready-made request
  useEffect(() => {
    if (!autoSend || sentAutoRef.current === autoSend.id) return;
    sentAutoRef.current = autoSend.id;
    send(autoSend.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend]);

  // Show what this chat saved from the live task list, so ticks and deletes elsewhere show up here too
  const savedTasks = useMemo(() => {
    const ids = new Set(created.map((t) => t.id));
    return tasks.filter((t) => ids.has(t.id)).sort((a, b) => a.date.localeCompare(b.date));
  }, [created, tasks]);
  const byDay = useMemo(() => {
    const groups = new Map();
    savedTasks.forEach((t) => groups.set(t.date, [...(groups.get(t.date) || []), t]));
    return [...groups];
  }, [savedTasks]);
  const openTasks = savedTasks.filter((t) => !t.done);
  const totalXp = savedTasks.reduce((sum, t) => sum + (t.xp || 0), 0);
  const totalMinutes = savedTasks.reduce((sum, t) => sum + (t.estMinutes || 0), 0);

  const undo = async () => {
    if (!openTasks.length || !window.confirm(`Remove the ${openTasks.length} unfinished tasks this added?`)) return;
    try {
      await deleteTasks(uid, openTasks.map((t) => t.id));
      onFlash("Removed.");
    } catch (err) {
      console.error("Undo failed", err);
      setError("Couldn't remove them. Check your connection.");
    }
  };

  return (
    <>
      <div className="task-panel task-panel--padded planner__chat">
        <div className="planner__head">
          <p className="page-hint">{mode.hint}</p>
          {started && <button className="planner__new" onClick={onNew} disabled={busy}>+ New chat</button>}
        </div>

        {!started && (
          <div className="planner__examples">
            {mode.examples.map((ex) => (
              <button key={ex} className="planner__example" onClick={() => send(ex)} disabled={busy}>{ex}</button>
            ))}
          </div>
        )}

        <div className="planner__log" aria-live="polite">
          {chat.map((m, i) => (
            <div key={i} className={`planner__msg planner__msg--${m.from}`}>
              {m.text}
              {m.reads?.length > 0 && (
                <div className="planner__sources">
                  📖 Read: {m.reads.map((r) => `${r.courseCode} · ${r.label}`).join(", ")}
                </div>
              )}
              {m.model && <div className="planner__model">🤖 {modelLabel(m.model)}</div>}
            </div>
          ))}
          {busy && (
            <ul className="planner__steps">
              {steps.map((s, i) => {
                const now = i === steps.length - 1;
                return <li key={s} className={now ? "planner__step--now" : ""}>{now ? "▸" : "✓"} {s}{now ? "…" : ""}</li>;
              })}
            </ul>
          )}
        </div>

        {error && <div className="form-error">{error}</div>}
        {otherModel && canContinue && (
          <p className="planner__model-note">
            This chat stays on {modelLabel(chatModel)}. Start a new chat to use {modelLabel(model)}.
          </p>
        )}

        {canContinue ? (
          <form className="planner__form" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <textarea
              className="form-input"
              placeholder={started ? "Reply or ask for changes…" : mode.placeholder}
              value={input}
              maxLength={1000}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              disabled={busy}
            />
            <button type="submit" className="submit-btn" disabled={busy || !input.trim()}>
              {busy ? "WORKING…" : started ? "SEND" : mode.button}
            </button>
          </form>
        ) : (
          <button className="submit-btn" onClick={onNew}>START A NEW CHAT</button>
        )}
      </div>

      {savedTasks.length > 0 && (
        <aside className="side-card planner__plan">
          <div className="side-card__title">{mode.sideTitle}</div>
          <div className="planner__total">
            {totalXp} XP · {savedTasks.length} tasks{totalMinutes ? ` · ${fmtMinutes(totalMinutes)}` : ""}
          </div>
          {byDay.map(([date, list]) => (
            <div key={date} className="planner__day">
              <div className="planner__day-label">{dayLabel(date)}</div>
              {list.map((t) => (
                <div key={t.id} className={`planner__task ${t.done ? "planner__task--done" : ""}`}>
                  <span className="planner__task-name">
                    {t.kind === "deadline" ? "⚑ " : ""}{t.code} · {t.name}
                    {t.estMinutes ? <span className="planner__est"> ⏱ {fmtMinutes(t.estMinutes)}</span> : null}
                  </span>
                  <span className="xp-chip">+{t.xp} XP</span>
                </div>
              ))}
            </div>
          ))}
          {openTasks.length > 0 && <button className="planner__undo" onClick={undo} disabled={busy}>Undo</button>}
        </aside>
      )}
    </>
  );
}

const chatDate = (c) =>
  c.updatedAt?.toDate?.().toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) || "";

/* Past chats from all three agents, newest first. */
function ChatHistory({ uid, onOpen, onFlash }) {
  const { items, loading, error } = useChats(uid);

  const remove = async (c) => {
    if (!window.confirm(`Delete the chat “${c.title}”? Tasks it made stay on your list.`)) return;
    try {
      await deleteChat(uid, c.id);
      onFlash("Chat deleted.");
    } catch (err) {
      console.error("Delete chat failed", err);
      onFlash("Couldn't delete it. Check your connection.");
    }
  };

  const shown = items.filter((c) => MODES[c.agent]);

  return (
    <div className="task-panel task-panel--padded planner__history">
      <p className="page-hint">
        Your last {CHAT_HISTORY_LIMIT} chats. Open one to read it again or carry on where you left off. Older chats are removed automatically.
      </p>
      {loading && <p className="page-hint">Loading…</p>}
      {error && <div className="form-error">Couldn't load your chats. Check your connection.</div>}
      {!loading && !error && shown.length === 0 && (
        <p className="planner__history-empty">No chats yet. Start one in another tab and it shows up here.</p>
      )}
      <ul className="planner__history-list">
        {shown.map((c) => {
          const replies = (c.chat || []).filter((m) => m.from === "agent").length;
          const made = c.createdIds?.length || 0;
          return (
            <li key={c.id} className="planner__history-row">
              <button className="planner__history-open" onClick={() => onOpen(c)}>
                <span className="planner__history-title">{c.title}</span>
                <span className="planner__history-meta">
                  {MODES[c.agent].tab} · {chatDate(c)} · {replies} {replies === 1 ? "reply" : "replies"}
                  {made ? ` · ${made} tasks made` : ""}
                </span>
              </button>
              <button
                className="planner__history-delete"
                onClick={() => remove(c)}
                aria-label={`Delete chat ${c.title}`}
                title="Delete chat"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Planner page: the three chat agents + chat history ── */
export default function PlannerPage({ uid, tasks, onFlash, request, onRequestHandled }) {
  const [view, setView] = useState("planner"); // an agent, or "history"
  const [model, setModel] = useState(getChosenModel);
  const pickModel = (id) => {
    setModel(id);
    setChosenModel(id);
  };
  // Each new or reopened chat gets a new nonce, so AgentChat starts fresh.
  const [session, setSession] = useState({ nonce: 0, saved: null, autoSend: null });
  const handledRef = useRef(null);
  const fresh = (extra = {}) => setSession((s) => ({ nonce: s.nonce + 1, saved: null, autoSend: null, ...extra }));

  // "Break into steps" / "Review" elsewhere in the app open a new chat with a ready-made request
  useEffect(() => {
    if (!request?.agent || handledRef.current === request.id) return;
    handledRef.current = request.id;
    setView(request.agent);
    fresh({ autoSend: request });
    onRequestHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const openTab = (key) => {
    if (key === view) return;
    setView(key);
    if (key !== "history") fresh();
  };
  const openChat = (c) => {
    setView(c.agent);
    fresh({ saved: c });
  };

  const tabs = [...Object.entries(MODES).map(([key, m]) => [key, m.tab]), ["history", "🕘 History"]];

  return (
    <div className="planner-page">
      <div className="planner__tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            className={`filter-btn ${view === key ? "filter-btn--active" : ""}`}
            onClick={() => openTab(key)}
          >
            {label}
          </button>
        ))}
        <label className="planner__model-pick">
          <span>AI model</span>
          <select className="form-input" value={model} onChange={(e) => pickModel(e.target.value)}>
            {GEMINI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label} · {m.note}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={`planner ${view === "history" ? "planner--single" : ""}`}>
        {view === "history" ? (
          <ChatHistory uid={uid} onOpen={openChat} onFlash={onFlash} />
        ) : (
          <AgentChat
            key={`${view}-${session.nonce}`}
            uid={uid}
            agent={view}
            tasks={tasks}
            onFlash={onFlash}
            saved={session.saved}
            autoSend={session.autoSend}
            onNew={() => fresh()}
            model={model}
          />
        )}
      </div>
    </div>
  );
}
