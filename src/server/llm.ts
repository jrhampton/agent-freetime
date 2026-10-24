import type { AppSettings, ProviderId } from "./settings.js";

/** Minimal OpenAI-compatible chat client. FreeLLMAPI and OpenRouter both speak this wire format. */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  model: string;
  routedVia?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

function headersFor(provider: ProviderId, apiKey: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (provider === "openrouter") {
    h["HTTP-Referer"] = "https://github.com/jrhampton/agent-freetime";
    h["X-Title"] = "Agent Free Time";
  }
  return h;
}

function endpoint(baseUrl: string, path: string) {
  return baseUrl.replace(/\/+$/, "") + path;
}

export async function chat(
  settings: AppSettings,
  provider: ProviderId,
  model: string,
  messages: ChatMessage[],
  tools?: ToolDef[],
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const p = settings.providers[provider];
  if (!p) throw new LlmError(`Unknown provider ${provider}`);
  const body: Record<string, unknown> = {
    model: model || p.model || "auto",
    messages,
    temperature: opts.temperature ?? 0.9,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  let res: Response;
  try {
    res = await fetch(endpoint(p.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: headersFor(provider, p.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
  } catch (e: any) {
    const why = e?.name === "TimeoutError" ? "timed out" : (e?.cause?.code ?? e?.message ?? String(e));
    throw new LlmError(`Couldn't reach ${provider} at ${p.baseUrl}: ${why}`);
  }
  const text = await res.text();
  if (!res.ok) throw new LlmError(`${provider} ${res.status}: ${text.slice(0, 500)}`, res.status);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError(`${provider} returned non-JSON: ${text.slice(0, 200)}`);
  }
  const msg = json.choices?.[0]?.message ?? {};
  return {
    content: typeof msg.content === "string" ? msg.content : null,
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
    model: json.model ?? String(body.model),
    routedVia: res.headers.get("x-routed-via") ?? undefined,
  };
}

export async function embed(settings: AppSettings, texts: string[]): Promise<number[][] | null> {
  const e = settings.embeddings;
  if (!e.enabled || texts.length === 0) return null;
  const p = settings.providers[e.provider];
  try {
    const res = await fetch(endpoint(p.baseUrl, "/embeddings"), {
      method: "POST",
      headers: headersFor(e.provider, p.apiKey),
      body: JSON.stringify({ model: e.model || "auto", input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const out = (json.data ?? []).map((d: any) => d.embedding as number[]);
    return out.length === texts.length ? out : null;
  } catch {
    return null;
  }
}

export async function listModels(settings: AppSettings, provider: ProviderId): Promise<string[]> {
  const p = settings.providers[provider];
  const qs = provider === "freellmapi" ? "?available=true" : "";
  const res = await fetch(endpoint(p.baseUrl, "/models" + qs), {
    headers: headersFor(provider, p.apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new LlmError(`${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  const json: any = await res.json();
  return (json.data ?? []).map((m: any) => m.id as string).sort();
}
