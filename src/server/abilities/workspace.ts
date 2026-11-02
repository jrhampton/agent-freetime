import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Each agent's own folder. Everything an ability makes lands here, and nothing an ability does
 * can read or write outside it.
 */

export const WORKSPACE_LIMIT_BYTES = 200 * 1024 * 1024;
export const TEXT_FILE_LIMIT = 200 * 1024;
export const TEXT_EXTENSIONS = [".md", ".txt", ".ly", ".svg", ".json", ".csv"];

export function workspaceRoot(profileId: number, dataDir = config.dataDir): string {
  const dir = path.join(dataDir, "workspaces", String(profileId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a path the agent gave us inside its workspace. Throws on anything that would escape it:
 * absolute paths, `..`, and symlinks that point elsewhere.
 */
export function resolveIn(root: string, rel: string): string {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!clean || clean === ".") return root;
  if (clean.split("/").some((seg) => seg === "..")) throw new Error("paths can't contain ..");
  const full = path.resolve(root, clean);
  const rootReal = fs.realpathSync(root);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("that path is outside your workspace");
  // Walk up to the deepest part that exists and make sure it really is inside.
  let probe = full;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error("that path is outside your workspace");
  return full;
}

/** A safe file name from whatever the agent called something. */
export function slug(name: string, fallback = "untitled"): string {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || fallback;
}

export interface WsFile {
  path: string;
  size: number;
  modified: number;
}

export function listFiles(root: string, sub = ""): WsFile[] {
  const out: WsFile[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const st = fs.statSync(full);
        out.push({ path: path.relative(root, full).split(path.sep).join("/"), size: st.size, modified: st.mtimeMs });
      }
      if (out.length >= 2000) return;
    }
  };
  const start = resolveIn(root, sub);
  if (fs.existsSync(start) && fs.statSync(start).isDirectory()) walk(start);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function usedBytes(root: string): number {
  return listFiles(root).reduce((n, f) => n + f.size, 0);
}

/** Write a file the agent made, checking the workspace quota first. */
export function writeFileIn(root: string, rel: string, data: string | Buffer): string {
  const full = resolveIn(root, rel);
  const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  if (usedBytes(root) + size > WORKSPACE_LIMIT_BYTES) throw new Error("your workspace is full; ask the person to clear some space");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return full;
}

export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mid": "audio/midi",
  ".midi": "audio/midi",
  ".wav": "audio/wav",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ly": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
};
