import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import { bus } from "../bus.js";
import { byId, CATALOG, customSkillKey, parseAbilities, SHELVES } from "./catalog.js";
import { customSkills } from "./index.js";
import { detect, installEnv, jobFor, planInstall, RECIPES, recipeById, startInstall, tmpDir, type Detected } from "./software.js";
import { listFiles, MIME, resolveIn, workspaceRoot } from "./workspace.js";
import * as apps from "./apps.js";

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** A real test run after an install, so "installed" means "works". */
async function verify(id: string, d: Detected): Promise<string> {
  const dir = tmpDir();
  try {
    if (id === "blender") {
      const r = await apps.renderScene(dir, "check", { objects: [{ shape: "cube" }], samples: 4, resolution: [64, 64] }, 300_000);
      return `Test render worked (${r.seconds}s).`;
    }
    if (id === "lilypond") {
      await apps.engrave(dir, "check", "{ c'4 }");
      return "Test score engraved.";
    }
    if (id === "stockfish") {
      await apps.chessNew(dir, "white", 1);
      return "The engine answered.";
    }
    return `Found ${d.version || d.command?.join(" ")}.`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function softwareView(id: string, refresh = false) {
  const r = recipeById.get(id)!;
  const d = await detect(id, refresh);
  return { ...r, detected: { installed: d.installed, version: d.version ?? null }, plan: planInstall(r, installEnv()), job: jobFor(id) ?? null };
}

export function registerAbilityRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/abilities", async () => ({
    shelves: SHELVES,
    catalog: CATALOG,
    skills: customSkills(db),
    software: await Promise.all(RECIPES.map((r) => softwareView(r.id))),
    env: installEnv(),
    games: apps.listGames(),
  }));

  // ---- software
  app.post("/api/software/:id/check", async (req) => {
    const id = String((req.params as any).id);
    if (!recipeById.has(id)) throw new HttpError(404, "unknown software");
    return softwareView(id, true);
  });
  // The Install button. This is the only way a recipe runs: a request from the logged-in operator.
  app.post("/api/software/:id/install", async (req) => {
    const id = String((req.params as any).id);
    if (!recipeById.has(id)) throw new HttpError(404, "unknown software");
    try {
      return startInstall(id, (d) => verify(id, d));
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
  });

  // ---- custom skills
  const skillBody = (b: any) => {
    const name = String(b?.name ?? "").trim().slice(0, 60);
    if (!name) throw new HttpError(400, "name is required");
    return { name, description: String(b?.description ?? "").trim().slice(0, 300), body: String(b?.body ?? "").slice(0, 20_000) };
  };
  app.get("/api/skills", async () => customSkills(db));
  app.post("/api/skills", async (req) => {
    const s = skillBody(req.body);
    const info = db.prepare("INSERT INTO skills (name, description, body) VALUES (@name, @description, @body)").run(s);
    return db.prepare("SELECT * FROM skills WHERE id = ?").get(info.lastInsertRowid);
  });
  app.put("/api/skills/:id", async (req) => {
    const id = Number((req.params as any).id);
    const s = skillBody(req.body);
    const r = db.prepare("UPDATE skills SET name = @name, description = @description, body = @body, updated_at = datetime('now') WHERE id = @id").run({ ...s, id });
    if (!r.changes) throw new HttpError(404, "not found");
    return db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
  });
  app.delete("/api/skills/:id", async (req) => {
    const id = Number((req.params as any).id);
    db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    const key = customSkillKey(id);
    for (const p of db.prepare("SELECT id, abilities FROM profiles").all() as { id: number; abilities: string }[]) {
      const list = parseAbilities(p.abilities);
      if (list.includes(key)) db.prepare("UPDATE profiles SET abilities = ? WHERE id = ?").run(JSON.stringify(list.filter((x) => x !== key)), p.id);
    }
    return { ok: true };
  });

  // ---- wishes
  app.get("/api/wishes", async (req) => {
    const q = req.query as any;
    const where = ["1=1"];
    const args: unknown[] = [];
    if (q.profile_id) (where.push("w.profile_id = ?"), args.push(Number(q.profile_id)));
    if (q.status) (where.push("w.status = ?"), args.push(String(q.status)));
    return db.prepare(`SELECT w.*, p.name AS profile_name FROM wishes w JOIN profiles p ON p.id = w.profile_id WHERE ${where.join(" AND ")} ORDER BY w.id DESC LIMIT 200`).all(...args);
  });
  app.post("/api/wishes/:id/:action", async (req) => {
    const { id, action } = req.params as any;
    const w = db.prepare("SELECT * FROM wishes WHERE id = ?").get(Number(id)) as { id: number; profile_id: number; ability: string } | undefined;
    if (!w) throw new HttpError(404, "not found");
    if (action !== "grant" && action !== "dismiss") throw new HttpError(400, "grant or dismiss");
    if (action === "grant" && byId.has(w.ability)) {
      const p = db.prepare("SELECT abilities FROM profiles WHERE id = ?").get(w.profile_id) as { abilities: string };
      const list = parseAbilities(p.abilities);
      if (!list.includes(w.ability)) db.prepare("UPDATE profiles SET abilities = ? WHERE id = ?").run(JSON.stringify([...list, w.ability]), w.profile_id);
    }
    db.prepare("UPDATE wishes SET status = ?, told = 0 WHERE id = ?").run(action === "grant" ? "granted" : "dismissed", w.id);
    const row = db.prepare("SELECT * FROM wishes WHERE id = ?").get(w.id);
    bus.publish({ channel: "wish", profileId: w.profile_id, payload: row });
    return row;
  });

  // ---- each agent's workspace (its gallery)
  app.get("/api/profiles/:id/workspace", async (req) => {
    const id = Number((req.params as any).id);
    if (!db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id)) throw new HttpError(404, "not found");
    return listFiles(workspaceRoot(id));
  });
  app.get("/api/profiles/:id/workspace/file", async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id)) throw new HttpError(404, "not found");
    let full: string;
    try {
      full = resolveIn(workspaceRoot(id), String((req.query as any).path ?? ""));
    } catch {
      throw new HttpError(400, "bad path");
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, "not found");
    // Agent-made files are untrusted: no scripts, no sniffing, even when opened directly.
    reply
      .header("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-cache")
      .type(MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream");
    if ((req.query as any).download) reply.header("Content-Disposition", `attachment; filename="${path.basename(full).replace(/"/g, "")}"`);
    return fs.createReadStream(full);
  });

  // ---- text adventure shelf
  app.get("/api/if-games", async () => apps.listGames());
  app.post("/api/if-games", async (req) => {
    const b = (req.body ?? {}) as any;
    const name = path.basename(String(b.name ?? "")).replace(/[^\w.-]/g, "_");
    if (!apps.GAME_EXT.test(name)) throw new HttpError(400, "Story files end in .z3, .z5, .z8 or .zblorb");
    const data = Buffer.from(String(b.data ?? ""), "base64");
    if (!data.length || data.length > 1_400_000) throw new HttpError(400, "That file is empty or too big for a story file.");
    fs.writeFileSync(path.join(apps.gamesDir(), name), data);
    return apps.listGames();
  });
  app.delete("/api/if-games/:name", async (req) => {
    const name = path.basename(String((req.params as any).name));
    if (apps.GAME_EXT.test(name)) fs.rmSync(path.join(apps.gamesDir(), name), { force: true });
    return apps.listGames();
  });
}
