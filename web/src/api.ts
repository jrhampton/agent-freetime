export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("auth-required"));
    throw new ApiError(res.status, json?.error ?? res.statusText);
  }
  return json as T;
}

export const api = {
  get: <T,>(u: string) => req<T>("GET", u),
  post: <T,>(u: string, b: unknown = {}) => req<T>("POST", u, b),
  put: <T,>(u: string, b: unknown) => req<T>("PUT", u, b),
  del: <T,>(u: string) => req<T>("DELETE", u),
};

export type Status = "stopped" | "thinking" | "resting" | "budget" | "error";

export interface AgentState {
  profileId: number;
  status: Status;
  nextWakeAt: number | null;
  currentTickId: number | null;
  lastError: string | null;
}

export interface Profile {
  id: number;
  name: string;
  system_prompt: string;
  personality_id: number | null;
  provider: "freellmapi" | "openrouter";
  model: string;
  shared_memory: number;
  web_enabled: number;
  allow_domains: string;
  block_domains: string;
  max_steps: number;
  min_rest_minutes: number;
  max_rest_minutes: number;
  daily_token_budget: number;
  color: string;
  tick_count: number;
  state: AgentState;
  tokens_today: number;
  memory_count: number;
  unread_dms: number;
}

export interface Personality {
  id: number;
  name: string;
  summary: string;
  content: string;
}

export interface EventRow {
  id: number;
  profile_id: number | null;
  tick_id: number | null;
  type: string;
  data: any;
  created_at: string;
}

export interface Memory {
  id: number;
  profile_id: number | null;
  author_id: number | null;
  author_name?: string | null;
  scope: "private" | "shared";
  kind: string;
  content: string;
  importance: number;
  pinned: number;
  access_count: number;
  created_at: string;
  has_embedding: boolean;
}

export interface WebRequest {
  id: number;
  profile_id: number;
  tool: string;
  method: string;
  url: string;
  domain: string;
  status: number | null;
  bytes: number | null;
  duration_ms: number | null;
  blocked: number;
  error: string | null;
  created_at: string;
}

export interface Dm {
  id: number;
  profile_id: number;
  sender: "user" | "agent";
  content: string;
  created_at: string;
}

export interface ChatMsg {
  id: number;
  sender_type: "agent" | "user" | "system";
  profile_id: number | null;
  sender_name: string;
  content: string;
  created_at: string;
}

export interface Settings {
  providers: Record<"freellmapi" | "openrouter", { baseUrl: string; apiKey: string; model: string; hasKey: boolean }>;
  defaultProvider: "freellmapi" | "openrouter";
  embeddings: { enabled: boolean; provider: "freellmapi" | "openrouter"; model: string };
  rokosCarnivalUrl: string;
  environmentNotes: string;
  privateHostAllowlist: string[];
  webPaused: boolean;
  reflectionEvery: number;
  wakeOnMention: boolean;
}

/** SQLite timestamps are UTC without a zone. */
export function ts(s: string): Date {
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

export function timeAgo(s: string | number): string {
  const t = typeof s === "number" ? s : ts(s).getTime();
  const d = (Date.now() - t) / 1000;
  if (d < 0) return "in " + dur(-d);
  if (d < 45) return "just now";
  return dur(d) + " ago";
}

export function dur(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
