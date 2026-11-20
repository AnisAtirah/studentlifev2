import { useCallback, useEffect, useRef, useState } from "react";
import { playSound, unlockAudio } from "./sounds";

/* Minutes for each mode. "custom" uses the student's own lengths (state.custom). */
export const PRESETS = {
  classic: { label: "25 / 5", focus: 25, short: 5, long: 15 },
  deep: { label: "50 / 10", focus: 50, short: 10, long: 20 },
  custom: { label: "Custom" },
};

/* "timer" is a single countdown for one task: no breaks, no cycle. */
export const MODE_LABELS = { focus: "Focus", short: "Short break", long: "Long break", timer: "Timer" };

/* Allowed minutes for each length the student can set. */
export const LIMITS = { focus: [1, 180], short: [1, 60], long: [1, 90], timer: [1, 240] };

export const clampMinutes = (kind, value) => {
  const [min, max] = LIMITS[kind];
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};

const STORAGE_KEY = "studentlife.pomodoro";
const DEFAULT = {
  mode: "focus",
  running: false,
  endAt: null,
  remaining: null,
  preset: "classic",
  cycle: 0,
  custom: { focus: 25, short: 5, long: 15 },
  timerMinutes: 30,
  timerLabel: "",
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && PRESETS[saved.preset] && MODE_LABELS[saved.mode]) {
      const s = { ...DEFAULT, ...saved };
      // Older saves (or hand-edited ones) may be missing or out of range
      s.custom = {
        focus: clampMinutes("focus", s.custom?.focus ?? DEFAULT.custom.focus),
        short: clampMinutes("short", s.custom?.short ?? DEFAULT.custom.short),
        long: clampMinutes("long", s.custom?.long ?? DEFAULT.custom.long),
      };
      s.timerMinutes = clampMinutes("timer", s.timerMinutes);
      s.timerLabel = typeof s.timerLabel === "string" ? s.timerLabel : "";
      return s;
    }
  } catch {
    // storage blocked or corrupt: start fresh
  }
  return DEFAULT;
}

/* Length in minutes of the given mode under the current settings. */
function minutesFor(s, mode) {
  if (mode === "timer") return s.timerMinutes;
  if (s.preset === "custom") return s.custom[mode];
  return PRESETS[s.preset][mode];
}

export function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

/* Stops the current session so new lengths take effect. */
const stopped = { running: false, endAt: null, remaining: null };

/*
 * Pomodoro timer that keeps running while you switch pages (and across reloads),
 * because it stores the end time rather than counting down in memory.
 * onFinish(mode, minutes) is called once when a session completes.
 */
export function usePomodoro(onFinish) {
  const [s, setS] = useState(load);
  const [now, setNow] = useState(() => Date.now());
  const onFinishRef = useRef(onFinish);
  const finishedFor = useRef(null);
  onFinishRef.current = onFinish;

  const minutes = minutesFor(s, s.mode);
  const durationMs = minutes * 60000;
  const left = s.running ? Math.max(0, s.endAt - now) : (s.remaining ?? durationMs);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      // ignore: the timer still works for this visit
    }
  }, [s]);

  useEffect(() => {
    if (!s.running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [s.running]);

  const advance = useCallback((completed) => {
    setS(prev => {
      // A single timer just resets so the same task can be timed again
      if (prev.mode === "timer") return { ...prev, ...stopped };
      const cycle = prev.mode === "focus" && completed ? prev.cycle + 1 : prev.cycle;
      const next = prev.mode !== "focus" ? "focus" : cycle > 0 && cycle % 4 === 0 ? "long" : "short";
      return { ...prev, ...stopped, mode: next, cycle };
    });
  }, []);

  // Session finished
  useEffect(() => {
    if (!s.running || now < s.endAt || finishedFor.current === s.endAt) return;
    finishedFor.current = s.endAt;
    playSound(s.mode === "short" || s.mode === "long" ? "breakDone" : "focusDone");
    onFinishRef.current?.(s.mode, minutes);
    advance(true);
  }, [now, s.running, s.endAt, s.mode, minutes, advance]);

  return {
    mode: s.mode,
    preset: s.preset,
    running: s.running,
    cycle: s.cycle,
    custom: s.custom,
    timerMinutes: s.timerMinutes,
    timerLabel: s.timerLabel,
    /* What to call the current session, e.g. "Short break" or the task being timed */
    title: s.mode === "timer" && s.timerLabel ? s.timerLabel : MODE_LABELS[s.mode],
    left,
    progress: 1 - left / durationMs,
    start: () => {
      unlockAudio(); // must happen during a click so the end-of-session alarm can play later
      playSound("start");
      const t = Date.now();
      setNow(t);
      setS(prev => ({ ...prev, running: true, endAt: t + left, remaining: null }));
    },
    pause: () => {
      playSound("pause");
      setS(prev => ({ ...prev, running: false, endAt: null, remaining: left }));
    },
    reset: () => {
      playSound("click");
      setS(prev => ({ ...prev, ...stopped }));
    },
    skip: () => {
      playSound("skip");
      advance(false);
    },
    setMode: mode => {
      playSound("click");
      setS(prev => ({ ...prev, ...stopped, mode }));
    },
    setPreset: preset => setS(prev => ({ ...prev, ...stopped, preset })),
    /* changes: { focus?, short?, long? } in minutes */
    setCustom: changes => setS(prev => {
      const custom = { ...prev.custom };
      Object.entries(changes).forEach(([k, v]) => { custom[k] = clampMinutes(k, v); });
      return { ...prev, ...stopped, custom };
    }),
    setTimerMinutes: value => setS(prev => ({ ...prev, ...stopped, timerMinutes: clampMinutes("timer", value) })),
    // The label doesn't change the length, so a running timer keeps going
    setTimerLabel: label => setS(prev => ({ ...prev, timerLabel: label.slice(0, 60) })),
  };
}
