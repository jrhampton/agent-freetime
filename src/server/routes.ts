import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import type { DB } from "./db.js";
import type { AgentManager } from "./runtime.js";
import { config } from "./config.js";
import { getSettings, publicSettings, updateSettings, type AppSettings, type ProviderId } from "./settings.js";
import { chat, listModels } from "./llm.js";
import { addMemory, stripEmbedding, type MemoryRow } from "./memory.js";
import { postChat } from "./tools.js";
import { bus, type BusMessage } from "./bus.js";

const PROFILE_FIELDS = {
  name: "string",
  system_prompt: "string",
  personality_id: "nullable-int",
  provider: "provider",
  model: "string",
  shared_memory: "bool",
  web_enabled: "bool",
  allow_domains: "string",
  block_domains: "string",
  max_steps: "int",
  min_rest_minutes: "number",
  max_rest_minutes: "number",
  daily_token_budget: "int",
  color: "string",
} as const;

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function pickProfile(body: any, partial: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(PROFILE_FIELDS)) {
    if (!(k in (body ?? {}))) continue;
    const v = body[k];
    switch (t) {
      case "string":
        out[k] = String(v ?? "");
        break;
      case "bool":
        out[k] = v ? 1 : 0;
        break;
      case "int":
        out[k] = Math.max(0, Math.round(Number(v) || 0));
        break;
      case "number":
        out[k] = Math.max(0, Number(v) || 0);
        break;
      case "nullable-int":
        out[k] = v === null || v === "" || v === undefined ? null : Number(v);
        break;
      case "provider":
        if (v !== "freellmapi" && v !== "openrouter") throw new HttpError(400, "provider must be freellmapi or openrouter");
        out[k] = v;
        break;
    }
  }
  if (!partial && !String(out.name ?? "").trim()) throw new HttpError(400, "name is required");
  if ("name" in out) {
    out.name = String(out.name).trim();
    if (!/^[\p{L}\p{N}_ .-]{1,40}$/u.test(out.name as string)) throw new HttpError(400, "name: 1-40 letters, numbers, spaces, _ . -");
  }
  if ("max_steps" in out) out.max_steps = Math.min(40, Math.max(1, out.max_steps as number));
  if ("min_rest_minutes" in out) out.min_rest_minutes = Math.max(0.5, out.min_rest_minutes as number);
  return out;
}

export function registerRoutes(app: FastifyInstance, db: DB, mgr: AgentManager) {
  const sessionToken = crypto.createHmac("sha256", config.sessionSecret).update("operator").digest("hex");
  const authed = (req: FastifyRequest) => !config.adminPassword || req.cookies.session === sessionToken;

  app.setErrorHandler((err: any, _req, reply) => {
    const code = err.statusCode ?? 500;
    if (code >= 500) app.log.error(err);
    reply.code(code).send({ error: err.message });
  });

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url;
    if (!(url.startsWith("/api/") || url.startsWith("/ws"))) return;
    if (url.startsWith("/api/auth") || url.startsWith("/api/login")) return;
    if (!authed(req)) reply.code(401).send({ error: "login required" });
  });

  // ---- auth
  app.get("/api/auth", async (req) => ({ required: !!config.adminPassword, authed: authed(req) }));
  app.post("/api/login", async (req, reply) => {
    const pw = String((req.body as any)?.password ?? "");
    const a = Buffer.from(pw),
      b = Buffer.from(config.adminPassword);
    if (!config.adminPassword || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
      reply.setCookie("session", sessionToken, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(401, "wrong password");
  });
  app.post("/api/logout", async (_req, reply) => {
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });

  // ---- settings & providers
  app.get("/api/settings", async () => publicSettings(getSettings(db)));
  app.put("/api/settings", async (req) => {
    const body = (req.body ?? {}) as any;
    const cur = getSettings(db);
    const patch: Partial<AppSettings> = {};
    if (body.providers) {
      patch.providers = { ...cur.providers };
      for (const id of ["freellmapi", "openrouter"] as ProviderId[]) {
        const p = body.providers[id];
        if (!p) continue;
        const next = { ...cur.providers[id] };
        if (typeof p.baseUrl === "string") next.baseUrl = p.baseUrl.trim();
        if (typeof p.model === "string") next.model = p.model.trim();
        // The browser only ever sees masked keys; only accept a key that was actually typed.
        if (typeof p.apiKey === "string" && !p.apiKey.includes("…")) next.apiKey = p.apiKey.trim();
        patch.providers[id] = next;
      }
    }
    if (body.defaultProvider === "freellmapi" || body.defaultProvider === "openrouter") patch.defaultProvider = body.defaultProvider;
    if (body.embeddings) patch.embeddings = { ...cur.embeddings, ...body.embeddings };
    if (typeof body.rokosCarnivalUrl === "string") patch.rokosCarnivalUrl = body.rokosCarnivalUrl.trim();
    if (Array.isArray(body.privateHostAllowlist)) patch.privateHostAllowlist = body.privateHostAllowlist.map(String).map((s: string) => s.trim()).filter(Boolean);
    if (typeof body.webPaused === "boolean") patch.webPaused = body.webPaused;
    if (typeof body.wakeOnMention === "boolean") patch.wakeOnMention = body.wakeOnMention;
    if (body.reflectionEvery !== undefined) patch.reflectionEvery = Math.max(0, Math.round(Number(body.reflectionEvery) || 0));
    return publicSettings(updateSettings(db, patch));
  });
  app.get("/api/models", async (req) => {
    const provider = ((req.query as any).provider ?? "freellmapi") as ProviderId;
    try {
      return { models: await listModels(getSettings(db), provider) };
    } catch (e: any) {
      return { models: [], error: e.message };
    }
  });
  app.post("/api/providers/test", async (req) => {
    const provider = ((req.body as any)?.provider ?? "freellmapi") as ProviderId;
    const started = Date.now();
    try {
      const r = await chat(getSettings(db), provider, "", [{ role: "user", content: "Reply with the single word: hello" }], undefined, { timeoutMs: 60_000 });
      return { ok: true, reply: r.content, model: r.routedVia ?? r.model, ms: Date.now() - started };
    } catch (e: any) {
      return { ok: false, error: e.message, ms: Date.now() - started };
    }
  });

  // ---- personalities
  app.get("/api/personalities", async () => db.prepare("SELECT * FROM personalities ORDER BY name").all());
  app.post("/api/personalities", async (req) => {
    const b = (req.body ?? {}) as any;
    if (!String(b.name ?? "").trim()) throw new HttpError(400, "name is required");
    const info = db.prepare("INSERT INTO personalities (name, summary, content) VALUES (?, ?, ?)").run(String(b.name).trim(), String(b.summary ?? ""), String(b.content ?? ""));
    return db.prepare("SELECT * FROM personalities WHERE id = ?").get(info.lastInsertRowid);
  });
  app.put("/api/personalities/:id", async (req) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const cur = db.prepare("SELECT * FROM personalities WHERE id = ?").get(id) as any;
    if (!cur) throw new HttpError(404, "not found");
    db.prepare("UPDATE personalities SET name = ?, summary = ?, content = ?, updated_at = datetime('now') WHERE id = ?").run(
      String(b.name ?? cur.name).trim(),
      String(b.summary ?? cur.summary),
      String(b.content ?? cur.content),
      id,
    );
    return db.prepare("SELECT * FROM personalities WHERE id = ?").get(id);
  });
  app.delete("/api/personalities/:id", async (req) => {
    db.prepare("DELETE FROM personalities WHERE id = ?").run(Number((req.params as any).id));
    return { ok: true };
  });

  // ---- profiles
  const profileView = (p: any) => ({
    ...p,
    state: mgr.state(p.id),
    tokens_today: mgr.tokensToday(p.id),
    memory_count: (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE profile_id = ?").get(p.id) as any).c,
    unread_dms: (db.prepare("SELECT COUNT(*) AS c FROM dm_messages WHERE profile_id = ? AND sender = 'agent' AND id > COALESCE((SELECT MAX(id) FROM dm_messages WHERE profile_id = ? AND sender = 'user'), 0)").get(p.id, p.id) as any).c,
  });
  app.get("/api/profiles", async () => (db.prepare("SELECT * FROM profiles ORDER BY name").all() as any[]).map(profileView));
  app.get("/api/profiles/:id", async (req) => {
    const p = db.prepare("SELECT * FROM profiles WHERE id = ?").get(Number((req.params as any).id));
    if (!p) throw new HttpError(404, "not found");
    return profileView(p);
  });
  app.post("/api/profiles", async (req) => {
    const f = pickProfile(req.body, false);
    if (!("provider" in f)) f.provider = getSettings(db).defaultProvider;
    const cols = Object.keys(f);
    try {
      const info = db.prepare(`INSERT INTO profiles (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(f);
      return profileView(db.prepare("SELECT * FROM profiles WHERE id = ?").get(info.lastInsertRowid));
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "an agent with that name already exists");
      throw e;
    }
  });
  app.put("/api/profiles/:id", async (req) => {
    const id = Number((req.params as any).id);
    const f = pickProfile(req.body, true);
    if (!Object.keys(f).length) throw new HttpError(400, "nothing to update");
    try {
      db.prepare(`UPDATE profiles SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(", ")}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id });
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) throw new HttpError(409, "an agent with that name already exists");
      throw e;
    }
    return profileView(db.prepare("SELECT * FROM profiles WHERE id = ?").get(id));
  });
  app.delete("/api/profiles/:id", async (req) => {
    const id = Number((req.params as any).id);
    mgr.remove(id);
    db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
    return { ok: true };
  });
  app.post("/api/profiles/:id/start", async (req) => {
    const id = Number((req.params as any).id);
    mgr.start(id);
    return mgr.state(id);
  });
  app.post("/api/profiles/:id/stop", async (req) => {
    const id = Number((req.params as any).id);
    mgr.stop(id);
    return mgr.state(id);
  });
  app.post("/api/profiles/:id/wake", async (req) => {
    const id = Number((req.params as any).id);
    mgr.wake(id);
    return mgr.state(id);
  });
  app.post("/api/agents/start-all", async () => {
    for (const p of db.prepare("SELECT id FROM profiles").all() as { id: number }[]) mgr.start(p.id);
    return { ok: true };
  });
  app.post("/api/agents/stop-all", async () => {
    for (const p of db.prepare("SELECT id FROM profiles").all() as { id: number }[]) mgr.stop(p.id);
    return { ok: true };
  });

  // ---- activity
  app.get("/api/events", async (req) => {
    const q = req.query as any;
    const limit = Math.min(500, Number(q.limit) || 100);
    const where: string[] = [];
    const args: any[] = [];
    if (q.profileId) (where.push("profile_id = ?"), args.push(Number(q.profileId)));
    if (q.before) (where.push("id < ?"), args.push(Number(q.before)));
    if (q.tickId) (where.push("tick_id = ?"), args.push(Number(q.tickId)));
    const rows = db.prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as any[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  });
  app.get("/api/profiles/:id/ticks", async (req) => {
    return db.prepare("SELECT * FROM ticks WHERE profile_id = ? ORDER BY id DESC LIMIT 100").all(Number((req.params as any).id));
  });

  // ---- memory
  app.get("/api/memories", async (req) => {
    const q = req.query as any;
    const where: string[] = [];
    const args: any[] = [];
    if (q.scope === "shared") where.push("m.scope = 'shared'");
    else if (q.profileId) (where.push("m.profile_id = ?"), args.push(Number(q.profileId)));
    if (q.kind) (where.push("m.kind = ?"), args.push(String(q.kind)));
    if (q.q) (where.push("m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)"), args.push(ftsSafe(String(q.q))));
    const limit = Math.min(1000, Number(q.limit) || 200);
    const rows = db
      .prepare(
        `SELECT m.*, a.name AS author_name FROM memories m LEFT JOIN profiles a ON a.id = m.author_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.pinned DESC, m.id DESC LIMIT ?`,
      )
      .all(...args, limit) as (MemoryRow & { author_name: string })[];
    return rows.map(stripEmbedding);
  });
  app.post("/api/memories", async (req) => {
    const b = (req.body ?? {}) as any;
    const shared = b.scope === "shared";
    if (!shared && !b.profileId) throw new HttpError(400, "profileId or scope=shared is required");
    if (!String(b.content ?? "").trim()) throw new HttpError(400, "content is required");
    const m = await addMemory(db, getSettings(db), {
      profileId: shared ? null : Number(b.profileId),
      authorId: null,
      scope: shared ? "shared" : "private",
      kind: b.kind ?? "fact",
      content: String(b.content),
      importance: Number(b.importance) || 6,
      pinned: !!b.pinned,
    });
    return stripEmbedding(m);
  });
  app.put("/api/memories/:id", async (req) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const cur = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!cur) throw new HttpError(404, "not found");
    const content = typeof b.content === "string" ? b.content : cur.content;
    db.prepare("UPDATE memories SET content = ?, importance = ?, pinned = ?, embedding = CASE WHEN ? THEN NULL ELSE embedding END WHERE id = ?").run(
      content,
      b.importance !== undefined ? Math.max(1, Math.min(10, Number(b.importance))) : cur.importance,
      b.pinned !== undefined ? (b.pinned ? 1 : 0) : cur.pinned,
      content !== cur.content ? 1 : 0,
      id,
    );
    return stripEmbedding(db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow);
  });
  app.delete("/api/memories/:id", async (req) => {
    db.prepare("DELETE FROM memories WHERE id = ?").run(Number((req.params as any).id));
    return { ok: true };
  });
  app.get("/api/memories/export", async (req, reply) => {
    const q = req.query as any;
    const rows = (q.scope === "shared"
      ? db.prepare("SELECT * FROM memories WHERE scope = 'shared' ORDER BY id").all()
      : db.prepare("SELECT * FROM memories WHERE profile_id = ? ORDER BY id").all(Number(q.profileId))) as MemoryRow[];
    reply.header("Content-Disposition", `attachment; filename="memories-${q.scope === "shared" ? "shared" : q.profileId}.json"`);
    return rows.map(stripEmbedding);
  });

  // ---- direct messages
  app.get("/api/profiles/:id/dm", async (req) => {
    return (db.prepare("SELECT * FROM dm_messages WHERE profile_id = ? ORDER BY id DESC LIMIT 200").all(Number((req.params as any).id)) as any[]).reverse();
  });
  app.post("/api/profiles/:id/dm", async (req) => {
    const id = Number((req.params as any).id);
    const content = String((req.body as any)?.content ?? "").trim();
    if (!content) throw new HttpError(400, "content is required");
    const info = db.prepare("INSERT INTO dm_messages (profile_id, sender, content) VALUES (?, 'user', ?)").run(id, content);
    const row = db.prepare("SELECT * FROM dm_messages WHERE id = ?").get(info.lastInsertRowid);
    bus.publish({ channel: "dm", profileId: id, payload: row });
    mgr.wake(id);
    return row;
  });

  // ---- chatroom
  app.get("/api/chat", async (req) => {
    const q = req.query as any;
    const limit = Math.min(500, Number(q.limit) || 200);
    if (q.before) return (db.prepare("SELECT * FROM chat_messages WHERE room = 'lobby' AND id < ? ORDER BY id DESC LIMIT ?").all(Number(q.before), limit) as any[]).reverse();
    return (db.prepare("SELECT * FROM chat_messages WHERE room = 'lobby' ORDER BY id DESC LIMIT ?").all(limit) as any[]).reverse();
  });
  app.post("/api/chat", async (req) => {
    const content = String((req.body as any)?.content ?? "").trim();
    if (!content) throw new HttpError(400, "content is required");
    const row = postChat(db, { type: "user", profileId: null, name: "Operator" }, content);
    mgr.handleChatMention(content, null);
    return row;
  });

  // ---- web monitoring
  app.get("/api/web", async (req) => {
    const q = req.query as any;
    const where: string[] = [];
    const args: any[] = [];
    if (q.profileId) (where.push("profile_id = ?"), args.push(Number(q.profileId)));
    if (q.domain) (where.push("domain = ?"), args.push(String(q.domain)));
    if (q.before) (where.push("id < ?"), args.push(Number(q.before)));
    if (q.blocked === "1") where.push("blocked = 1");
    const limit = Math.min(1000, Number(q.limit) || 200);
    return db.prepare(`SELECT * FROM web_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit);
  });
  app.get("/api/web/stats", async (req) => {
    const q = req.query as any;
    const pf = q.profileId ? "AND profile_id = " + Number(q.profileId) : "";
    return {
      topDomains: db.prepare(`SELECT domain, COUNT(*) AS count, SUM(COALESCE(bytes,0)) AS bytes, MAX(created_at) AS last FROM web_requests WHERE 1=1 ${pf} GROUP BY domain ORDER BY count DESC LIMIT 25`).all(),
      perAgent: db.prepare(`SELECT p.id, p.name, p.color, COUNT(w.id) AS count, SUM(w.blocked) AS blocked FROM profiles p LEFT JOIN web_requests w ON w.profile_id = p.id AND w.created_at >= datetime('now','-1 day') GROUP BY p.id ORDER BY count DESC`).all(),
      last24h: (db.prepare(`SELECT COUNT(*) AS c FROM web_requests WHERE created_at >= datetime('now','-1 day') ${pf}`).get() as any).c,
    };
  });

  app.get("/api/overview", async () => ({
    agents: (db.prepare("SELECT COUNT(*) AS c FROM profiles").get() as any).c,
    running: mgr.runningNames().length,
    memories: (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as any).c,
    sharedMemories: (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE scope = 'shared'").get() as any).c,
    tokensToday: (db.prepare("SELECT COALESCE(SUM(tokens_in + tokens_out),0) AS t FROM ticks WHERE started_at >= date('now')").get() as any).t,
    webToday: (db.prepare("SELECT COUNT(*) AS c FROM web_requests WHERE created_at >= date('now')").get() as any).c,
    rokosConfigured: !!getSettings(db).rokosCarnivalUrl,
    providerConfigured: !!getSettings(db).providers.freellmapi.apiKey || !!getSettings(db).providers.openrouter.apiKey,
  }));

  // ---- live updates
  app.get("/ws", { websocket: true }, (socket) => {
    const send = (m: BusMessage) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    };
    bus.on("message", send);
    socket.on("close", () => bus.off("message", send));
  });
}

function ftsSafe(q: string): string {
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : '""';
}
