import { todayKey } from "./dateUtils";

/*
 * Today's quests, picked automatically by the quest agent when the app opens.
 * Clicking a quest ticks its task; finishing it today pays the quest's bonus XP.
 */
export default function QuestBoard({ board, tasks, onToggle, onRetry }) {
  const isToday = board?.date === todayKey();
  const hasOpenTasks = tasks.some((t) => !t.done);

  let body;
  if (!isToday) {
    body = <div className="side-empty">{hasOpenTasks ? "Opening the quest board…" : "No open tasks. Add one to get quests! 🗺️"}</div>;
  } else if (board.status === "picking") {
    body = <div className="quest-board__status">🔮 Your buddy is picking today's quests…</div>;
  } else if (board.status === "error") {
    body = (
      <>
        <div className="side-empty">{board.error || "Couldn't pick quests today."}</div>
        <button className="planner__new quest-board__retry" onClick={onRetry}>Try again</button>
      </>
    );
  } else {
    const cleared = board.quests.length > 0 && board.quests.every((q) => q.done);
    body = (
      <>
        {board.message && <div className="quest-board__message">“{board.message}”</div>}
        <ul className="quest-board__list">
          {board.quests.map((q) => {
            const task = tasks.find((t) => t.id === q.taskId);
            const gone = !task;
            return (
              <li key={q.taskId}>
                <button
                  className={`quest ${q.done ? "quest--done" : ""}`}
                  onClick={() => !gone && !q.done && onToggle(q.taskId)}
                  disabled={gone || q.done}
                  title={gone ? "This task was deleted" : task.done ? "Already ticked" : `Finish "${task.name}"`}
                >
                  <span className="quest__box">{q.done ? "✔" : ""}</span>
                  <span className="quest__title">{q.title}</span>
                  <span className="xp-chip">+{q.xp} XP</span>
                </button>
              </li>
            );
          })}
        </ul>
        {cleared && <div className="quest-board__cleared">🏆 Board cleared! See you tomorrow.</div>}
      </>
    );
  }

  return (
    <div className="side-card quest-board">
      <div className="side-card__title">⚔️ Today's quests</div>
      {body}
    </div>
  );
}
