import type { DB } from "./db.js";
import { config } from "./config.js";

export type ProviderId = "freellmapi" | "openrouter";

export interface ProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppSettings {
  providers: Record<ProviderId, ProviderSettings>;
  defaultProvider: ProviderId;
  embeddings: { enabled: boolean; provider: ProviderId; model: string };
  rokosCarnivalUrl: string;
  /** Free-form notes added to every agent's environment prompt (e.g. Roko's app list, API guides, keys). */
  environmentNotes: string;
  /** Extra hosts agents may reach even if they resolve to private addresses (e.g. Roko's on the same box). */
  privateHostAllowlist: string[];
  webPaused: boolean;
  reflectionEvery: number;
  wakeOnMention: boolean;
}

export function defaultSettings(): AppSettings {
  return {
    providers: {
      freellmapi: {
        baseUrl: config.seed.freellmapiBaseUrl,
        apiKey: config.seed.freellmapiApiKey,
        model: config.seed.freellmapiModel,
      },
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: config.seed.openrouterApiKey,
        model: config.seed.openrouterModel,
      },
    },
    defaultProvider: "freellmapi",
    embeddings: { enabled: true, provider: "freellmapi", model: "" },
    rokosCarnivalUrl: config.seed.rokosCarnivalUrl,
    environmentNotes: "",
    privateHostAllowlist: [],
    webPaused: false,
    reflectionEvery: 8,
    wakeOnMention: true,
  };
}

let cache: AppSettings | null = null;

export function getSettings(db: DB): AppSettings {
  if (cache) return cache;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
  const base = defaultSettings();
  if (!row) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify(base));
    cache = base;
    return base;
  }
  const stored = JSON.parse(row.value) as Partial<AppSettings>;
  cache = mergeSettings(base, stored);
  return cache;
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    providers: {
      freellmapi: { ...base.providers.freellmapi, ...patch.providers?.freellmapi },
      openrouter: { ...base.providers.openrouter, ...patch.providers?.openrouter },
    },
    embeddings: { ...base.embeddings, ...patch.embeddings },
  };
}

export function updateSettings(db: DB, patch: Partial<AppSettings>): AppSettings {
  const next = mergeSettings(getSettings(db), patch);
  db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(next),
  );
  cache = next;
  return next;
}

/** Settings as shown to the browser: API keys are masked. */
export function publicSettings(s: AppSettings) {
  const mask = (k: string) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : "");
  return {
    ...s,
    providers: {
      freellmapi: { ...s.providers.freellmapi, apiKey: mask(s.providers.freellmapi.apiKey), hasKey: !!s.providers.freellmapi.apiKey },
      openrouter: { ...s.providers.openrouter, apiKey: mask(s.providers.openrouter.apiKey), hasKey: !!s.providers.openrouter.apiKey },
    },
  };
}

export function resetSettingsCache() {
  cache = null;
}
