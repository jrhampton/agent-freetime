import path from "node:path";
import crypto from "node:crypto";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  // When ADMIN_PASSWORD is empty the UI is open. Always set it on a public server.
  adminPassword: env("ADMIN_PASSWORD"),
  sessionSecret: env("SESSION_SECRET", crypto.randomBytes(32).toString("hex")),
  // These seed the settings table on first boot; after that, edit them in the UI.
  seed: {
    freellmapiBaseUrl: env("FREELLMAPI_BASE_URL", "http://localhost:3001/v1"),
    freellmapiApiKey: env("FREELLMAPI_API_KEY"),
    freellmapiModel: env("FREELLMAPI_MODEL", "auto"),
    openrouterApiKey: env("OPENROUTER_API_KEY"),
    openrouterModel: env("OPENROUTER_MODEL", "openrouter/auto"),
    rokosCarnivalUrl: env("ROKOS_CARNIVAL_URL"),
  },
};
