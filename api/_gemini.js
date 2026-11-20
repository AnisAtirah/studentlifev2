/*
 * Gemini adapter for /api/agent.
 *
 * The browser's agent loop speaks the Claude message format (text, tool_use and
 * tool_result blocks). This file translates that conversation to Gemini's
 * generateContent REST API and translates the answer back, so nothing else in
 * the app has to know which model is behind it.
 *
 * Gemini's own reply parts (which can carry "thought signatures" that Gemini
 * needs back on the next turn) travel inside one extra { type: "gemini", parts }
 * block. The loop ignores that block and returns it unchanged, and this file
 * sends those parts back exactly as Gemini wrote them.
 */

const API = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* Gemini accepts a subset of JSON Schema, so keep only the parts it understands. */
function toGeminiSchema(schema) {
  const out = {};
  if (schema.type) out.type = schema.type;
  let description = schema.description || "";
  if (schema.format === "date") description = `${description} (YYYY-MM-DD)`.trim();
  if (description) out.description = description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (schema.required?.length) out.required = schema.required;
  }
  return out;
}

export function toGeminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const hasInput = Object.keys(t.input_schema?.properties || {}).length > 0;
        return {
          name: t.name,
          description: t.description,
          // Gemini rejects an object schema with no properties, so tools without input leave it out
          ...(hasInput ? { parameters: toGeminiSchema(t.input_schema) } : {}),
        };
      }),
    },
  ];
}

const resultText = (content) =>
  typeof content === "string" ? content : (content || []).map((b) => b.text || "").join("\n");

/* Claude-format messages -> Gemini contents. */
export function toGeminiContents(messages) {
  const callNames = new Map(); // tool_use id -> { name, geminiId }
  const contents = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content || [];
    let parts = [];

    if (role === "model") {
      blocks
        .filter((b) => b.type === "tool_use")
        .forEach((b) => callNames.set(b.id, { name: b.name, geminiId: b.gemini_id }));
      const raw = blocks.find((b) => b.type === "gemini");
      parts = raw
        ? raw.parts // Gemini's own reply, sent back unchanged
        : blocks.flatMap((b) => {
            if (b.type === "text" && b.text) return [{ text: b.text }];
            if (b.type === "tool_use") return [{ functionCall: { name: b.name, args: b.input || {} } }];
            return []; // e.g. Claude thinking blocks from an older chat
          });
    } else {
      parts = blocks.flatMap((b) => {
        if (b.type === "text" && b.text) return [{ text: b.text }];
        if (b.type === "tool_result") {
          const call = callNames.get(b.tool_use_id);
          const text = resultText(b.content);
          return [
            {
              functionResponse: {
                ...(call?.geminiId ? { id: call.geminiId } : {}),
                name: call?.name || "unknown_tool",
                response: b.is_error ? { error: text } : { result: text },
              },
            },
          ];
        }
        return [];
      });
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

/* Gemini response -> { content, stop_reason } in the Claude format the loop expects. */
export function fromGeminiResponse(data, model) {
  const candidate = data.candidates?.[0];
  if (!candidate) {
    if (data.promptFeedback?.blockReason) return { content: [], stop_reason: "refusal" };
    throw new GeminiError(502, "Gemini sent an empty answer.");
  }
  if (BLOCKED.has(candidate.finishReason)) return { content: [], stop_reason: "refusal" };
  if (candidate.finishReason === "MALFORMED_FUNCTION_CALL") {
    throw new GeminiError(502, "Gemini made a broken tool call.");
  }

  const parts = candidate.content?.parts || [];
  const content = parts.length ? [{ type: "gemini", model, parts }] : [];
  let calls = 0;
  parts.forEach((p, i) => {
    if (p.thought) return; // thinking summaries aren't shown
    if (p.functionCall) {
      calls++;
      content.push({
        type: "tool_use",
        id: `call_${Date.now().toString(36)}_${i}`,
        ...(p.functionCall.id ? { gemini_id: p.functionCall.id } : {}),
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    } else if (p.text) {
      content.push({ type: "text", text: p.text });
    }
  });

  const stop_reason = calls ? "tool_use" : candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
  return { content, stop_reason };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = new Set([429, 500, 503, 504]); // overloaded or rate-limited: worth another try
const ATTEMPT_MS = 25_000;
const isBusy = (err) =>
  (err instanceof GeminiError && BUSY.has(err.status)) || err?.name === "TimeoutError" || err?.name === "AbortError";

/* Model that already answered in this conversation, if any. Its thought
 * signatures only work with that same model, so the chat stays on it. */
export function conversationModel(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const raw = Array.isArray(m.content) && m.content.find((b) => b.type === "gemini" && b.model);
    if (raw) return raw.model;
  }
  return null;
}

async function requestOnce({ apiKey, model, body, timeoutMs }) {
  const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body,
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GeminiError(res.status, data.error?.message || `Gemini error ${res.status}`);
  return { ...fromGeminiResponse(data, model), model };
}

/*
 * When Gemini is busy (503 "high demand", 429), wait and try again. A new
 * conversation can also move to fallbackModel; an ongoing one stays on its model.
 * Everything finishes within ~55 s, under the function's 60 s limit.
 */
export async function callGemini({ apiKey, model, fallbackModel, system, tools, messages, maxTokens = 16000 }) {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    tools: toGeminiTools(tools),
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { maxOutputTokens: maxTokens },
  });
  const deadline = Date.now() + 55_000;
  const pinned = conversationModel(messages);
  const plan = pinned
    ? [[pinned, 0], [pinned, 2000], [pinned, 5000]]
    : [[model, 0], [model, 2000], ...(fallbackModel && fallbackModel !== model ? [[fallbackModel, 0], [fallbackModel, 3000]] : [[model, 5000]])];

  let lastErr;
  const limited = new Set(); // models that said 429: their per-minute quota is used up, so retrying only wastes more
  for (const [i, [m, wait]] of plan.entries()) {
    if (limited.has(m)) continue;
    if (wait) {
      if (Date.now() + wait + 5000 > deadline) break;
      await sleep(wait);
    }
    // A slow attempt mustn't use up all the time while a fallback model is still
    // waiting its turn. Otherwise (e.g. an ongoing chat) it gets all the time left.
    const fallbackLater = plan.slice(i + 1).some(([other]) => other !== m);
    const left = deadline - Date.now();
    try {
      return await requestOnce({ apiKey, model: m, body, timeoutMs: fallbackLater ? Math.min(ATTEMPT_MS, left) : left });
    } catch (err) {
      lastErr = err;
      if (!isBusy(err)) throw err;
      if (err.status === 429) limited.add(m);
      console.warn(`Gemini ${m} busy (${err.status || err.name}), trying again`);
    }
  }
  if (lastErr instanceof GeminiError) throw lastErr;
  throw new GeminiError(503, "Gemini took too long to answer.");
}
