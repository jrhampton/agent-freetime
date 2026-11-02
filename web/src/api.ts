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
  session_minutes: number;
  daily_token_budget: number;
  color: string;
  tick_count: number;
  /** JSON list of ability ids. */
  abilities: string;
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

export interface Ability {
  id: string;
  name: string;
  shelf: string;
  kind: "skill" | "builtin" | "software";
  summary: string;
  joke?: string;
  default?: boolean;
  alwaysOut?: boolean;
  software?: string;
  needsWeb?: boolean;
  later?: boolean;
  body?: string;
}

export interface InstallJob {
  recipe: string;
  state: "running" | "verifying" | "done" | "failed";
  command: string[];
  log: string;
  error?: string;
}

export interface SoftwareInfo {
  id: string;
  name: string;
  about: string;
  homepage: string;
  size: string;
  touches: string;
  manualUrl: string;
  detected: { installed: boolean; version: string | null };
  plan: { ok: boolean; installer?: string; command?: string[]; reason?: string; manualUrl: string };
  job: InstallJob | null;
}

export interface CustomSkill {
  id: number;
  name: string;
  description: string;
  body: string;
}

export interface AbilitiesData {
  shelves: { id: string; name: string; blurb: string }[];
  catalog: Ability[];
  skills: CustomSkill[];
  software: SoftwareInfo[];
  env: { platform: string; docker: boolean };
  games: string[];
}

export interface Wish {
  id: number;
  profile_id: number;
  profile_name?: string;
  ability: string;
  reason: string;
  status: "open" | "granted" | "dismissed";
  created_at: string;
}

export interface WsFile {
  path: string;
  size: number;
  modified: number;
}

export function abilityList(p: Profile): string[] {
  try {
    const v = JSON.parse(p.abilities || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export const wsFileUrl = (profileId: number, path: string, download = false) =>
  `/api/profiles/${profileId}/workspace/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

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
