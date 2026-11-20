/*
 * The Gemini models a student can pick on the Planner page.
 *
 * Shared by the browser (the picker) and the server (api/agent.js only accepts
 * ids from this list, so the browser can't ask for some other, pricier model).
 * All of these are on Gemini's free tier.
 */

export const GEMINI_MODELS = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "default" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "smartest, often busy" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", note: "reliable" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", note: "fastest" },
];

export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";

export const isGeminiModel = (id) => GEMINI_MODELS.some((m) => m.id === id);

export const modelLabel = (id) => GEMINI_MODELS.find((m) => m.id === id)?.label || id;

/* The student's choice, remembered on this device. Falls back to the default
 * when storage is blocked (private window) or holds an old id. */
const KEY = "studentlife.geminiModel";

export function getChosenModel() {
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    return isGeminiModel(saved) ? saved : DEFAULT_GEMINI_MODEL;
  } catch {
    return DEFAULT_GEMINI_MODEL;
  }
}

export function setChosenModel(id) {
  try {
    globalThis.localStorage?.setItem(KEY, id);
  } catch {
    // not saved; the choice still applies until the page reloads
  }
}
