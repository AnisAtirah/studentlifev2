import Anthropic from "@anthropic-ai/sdk";
import { AGENTS } from "../src/agents/specs.js";
import { bearerToken, verifyFirebaseToken } from "./_auth.js";
import { callGemini, GeminiError } from "./_gemini.js";
import { DEFAULT_GEMINI_MODEL, isGeminiModel } from "../src/agents/models.js";

/*
 * POST /api/agent
 * One turn of a StudentLife agent (planner, quests, breakdown or review).
 *
 * The browser runs the agent loop and the tools (reading and writing Firestore
 * with the student's own login, so the security rules still apply). This
 * function only keeps the API key secret and fixes the model, prompt and tools
 * per agent, so it can't be used as a general-purpose AI proxy.
 *
 * Which AI runs is set in .env.local (and in Vercel's environment variables):
 *   AI_PROVIDER    "gemini" or "anthropic". If left out: gemini when
 *                  GEMINI_API_KEY is set, otherwise anthropic.
 *   GEMINI_MODEL   used when the browser doesn't pick one; default "gemini-3.7-flash".
 *                  Students pick a model on the Planner page, from src/agents/models.js.
 *   GEMINI_FALLBACK_MODEL  used for a new chat when the chosen model is overloaded,
 *                  default "gemini-3.6-flash" (set it empty to turn this off)
 *   CLAUDE_MODEL   default "claude-opus-5-5"
 *
 * Body:     { agent: "planner" | "quests" | "breakdown" | "review", messages: MessageParam[], model?: string }
 * Header:   Authorization: Bearer <Firebase ID token>
 * Response: { content, stop_reason, model } in the Claude format, whichever provider ran
 */

const MAX_MESSAGES = 60;
// Notes read from course links stay in the conversation, so allow room for a
// few parts (each ~30k characters) while staying under Vercel's 4.5 MB body limit.
const MAX_BODY_CHARS = 1_500_000;

const provider = () =>
  (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? "gemini" : "anthropic")).trim().toLowerCase();

/* A chat started on Gemini carries Gemini-only data that Claude would reject. */
const withoutGeminiParts = (messages) =>
  messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content
            .filter((b) => b.type !== "gemini")
            .map(({ gemini_id, ...b }) => b), // eslint-disable-line no-unused-vars
        }
      : m
  );

let anthropicClient;
async function askClaude(spec, messages) {
  anthropicClient ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const response = await anthropicClient.beta.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: spec.effort },
    // If a safety classifier declines, retry on Anthropic's recommended model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    system: spec.system,
    tools: spec.tools,
    messages: withoutGeminiParts(messages),
  });
  // Content goes back unchanged (thinking blocks included): the browser
  // appends it to the conversation and sends it again next turn.
  return { content: response.content, stop_reason: response.stop_reason, model: response.model };
}

/* The browser's choice if it's on the allowed list, otherwise the server setting. */
const geminiModel = (picked) =>
  isGeminiModel(picked) ? picked : process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

const askGemini = (spec, messages, picked) =>
  callGemini({
    apiKey: process.env.GEMINI_API_KEY,
    model: geminiModel(picked),
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.6-flash",
    system: spec.system,
    tools: spec.tools,
    messages,
  });

/* Turns provider errors into a status and a message the student can act on. */
function explain(err) {
  const status = err instanceof GeminiError || err instanceof Anthropic.APIError ? err.status : 500;
  if (status === 429) return [429, "The AI is busy or out of free requests. Try again in a minute."];
  if (status === 400) return [400, "The assistant couldn't read that conversation. Start a new one."];
  if (status === 401 || status === 403) return [500, "The AI key isn't valid. Check the key in the server settings."];
  if (status === 404) return [500, "That AI model wasn't found. Check GEMINI_MODEL or CLAUDE_MODEL."];
  if (status === 500) return [500, "Something went wrong with the assistant."];
  return [502, "The assistant is having trouble right now. Try again soon."];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  const useGemini = provider() === "gemini";
  const keyName = useGemini ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyName]) {
    return res.status(500).json({ error: `The AI helpers aren't set up yet (missing ${keyName}).` });
  }

  const uid = await verifyFirebaseToken(bearerToken(req));
  if (!uid) return res.status(401).json({ error: "Please sign in again." });

  const spec = Object.hasOwn(AGENTS, req.body?.agent) ? AGENTS[req.body.agent] : null;
  if (!spec) return res.status(400).json({ error: "Unknown agent." });

  const messages = req.body?.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES ||
    messages[0]?.role !== "user" ||
    JSON.stringify(messages).length > MAX_BODY_CHARS
  ) {
    return res.status(400).json({ error: "That conversation is too long. Start a new one." });
  }

  try {
    const result = useGemini ? await askGemini(spec, messages, req.body?.model) : await askClaude(spec, messages);
    return res.status(200).json(result);
  } catch (err) {
    console.error(`Agent failed (${useGemini ? "gemini" : "anthropic"})`, err.status || "", err.message);
    const [status, error] = explain(err);
    return res.status(status).json({ error });
  }
}
