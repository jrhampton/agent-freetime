import type { DB } from "./db.js";
import { parseDbTime } from "./db.js";
import { chat, type ChatMessage, LlmError } from "./llm.js";
import { getSettings, type ProviderId } from "./settings.js";
import { basePrompt, REFLECTION_PROMPT, SUMMARY_PROMPT } from "./prompts.js";
import { addMemory, formatMemory, pinnedMemories, recall, recentEpisodes } from "./memory.js";
import { formatChat, runTool, toolDefs, type ToolOutcome } from "./tools.js";
import { bus } from "./bus.js";
import { browserAvailable, closeBrowser } from "./browser.js";

export interface ProfileRow {
  id: number;
  name: string;
  system_prompt: string;
  personality_id: number | null;
  provider: ProviderId;
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
  autostart: number;
  last_chat_seen_id: number;
  tick_count: number;
}

export type AgentStatus = "stopped" | "thinking" | "resting" | "budget" | "error";

export interface AgentState {
  profileId: number;
  status: AgentStatus;
  nextWakeAt: number | null;
  currentTickId: number | null;
  lastError: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJsonLoose(s: string | null): any {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "less than a minute";
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

class AgentRunner {
  state: AgentState;
  private running = false;
  private wakeResolver: (() => void) | null = null;
  private restTimer: NodeJS.Timeout | null = null;
  private wakeRequested = false;
  private nudgeRequested = false;
  private lastTickEndedAt = 0;
  /** Chatroom messages that arrived mid-session, delivered before the agent's next step. */
  private chatNotes: { id: number; line: string }[] = [];
  private consecutiveErrors = 0;

  constructor(
    private mgr: AgentManager,
    profileId: number,
  ) {
    this.state = { profileId, status: "stopped", nextWakeAt: null, currentTickId: null, lastError: null };
  }

  get isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
    this.wake();
    this.setStatus("stopped", null);
  }

  /** Wake now (a direct message from the operator). */
  wake() {
    this.wakeRequested = true;
    this.wakeResolver?.();
  }

  /** Deliver a chatroom message into the session that's running now. Returns false if not mid-session. */
  notify(id: number, line: string): boolean {
    if (this.state.status !== "thinking") return false;
    this.chatNotes.push({ id, line });
    return true;
  }

  /**
   * Wake soon, but no sooner than the agent's minimum rest after its last session.
   * Used for chatroom mentions so two agents can't ping each other in a tight loop.
   */
  nudge(minRestMinutes: number) {
    const at = Math.max(Date.now(), this.lastTickEndedAt + minRestMinutes * 60_000);
    if (this.state.status === "thinking") {
      this.nudgeRequested = true;
      return;
    }
    if (this.state.status !== "resting" || !this.restTimer || (this.state.nextWakeAt ?? 0) <= at) return;
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => this.wakeResolver?.(), at - Date.now());
    this.setStatus("resting", at);
  }

  private setStatus(status: AgentStatus, nextWakeAt: number | null) {
    this.state = { ...this.state, status, nextWakeAt };
    bus.publish({ channel: "status", profileId: this.state.profileId, payload: this.state });
  }

  private async rest(minutes: number, status: AgentStatus = "resting") {
    if (!this.running) return;
    const until = Date.now() + minutes * 60_000;
    this.setStatus(status, until);
    await new Promise<void>((resolve) => {
      this.restTimer = setTimeout(resolve, Math.max(0, until - Date.now()));
      this.wakeResolver = () => {
        if (this.restTimer) clearTimeout(this.restTimer);
        resolve();
      };
    });
    this.restTimer = null;
    this.wakeResolver = null;
  }

  private async loop() {
    while (this.running) {
      const profile = this.mgr.getProfile(this.state.profileId);
      if (!profile) {
        this.running = false;
        break;
      }
      const used = this.mgr.tokensToday(profile.id);
      if (profile.daily_token_budget > 0 && used >= profile.daily_token_budget) {
        const now = new Date();
        const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        this.mgr.logEvent(profile.id, null, "status", { message: `Daily token budget reached (${used}). Resting until 00:00 UTC.` });
        this.wakeRequested = false;
        await this.rest((midnight - Date.now()) / 60_000, "budget");
        continue;
      }
      this.wakeRequested = false;
      this.nudgeRequested = false;
      let restMinutes: number;
      try {
        restMinutes = await this.tick(profile);
        this.consecutiveErrors = 0;
        this.state.lastError = null;
      } catch (e: any) {
        this.consecutiveErrors++;
        const msg = e instanceof LlmError ? e.message : String(e?.message ?? e);
        if (!(e instanceof LlmError)) console.error(e);
        this.state.lastError = msg.slice(0, 500);
        this.mgr.logEvent(profile.id, this.state.currentTickId, "error", { message: msg.slice(0, 2000) });
        if (this.state.currentTickId) this.mgr.db.prepare("UPDATE ticks SET ended_at = datetime('now'), error = ? WHERE id = ?").run(msg.slice(0, 2000), this.state.currentTickId);
        restMinutes = Math.min(60, 2 ** this.consecutiveErrors);
        this.setStatus("error", Date.now() + restMinutes * 60_000);
        await sleep(10);
      }
      this.state.currentTickId = null;
      this.lastTickEndedAt = Date.now();
      if (this.wakeRequested) restMinutes = Math.min(restMinutes, 0.1);
      else if (this.nudgeRequested) restMinutes = Math.min(restMinutes, profile.min_rest_minutes);
      this.wakeRequested = false;
      this.nudgeRequested = false;
      if (this.consecutiveErrors) await this.rest(restMinutes, "error");
      else await this.rest(restMinutes);
    }
    this.setStatus("stopped", null);
  }

  /** One session: build context, let the agent act with tools until it rests. Returns rest minutes. */
  private async tick(profile: ProfileRow): Promise<number> {
    const { db } = this.mgr;
    const settings = getSettings(db);
    const tickId = Number(db.prepare("INSERT INTO ticks (profile_id) VALUES (?)").run(profile.id).lastInsertRowid);
    this.state.currentTickId = tickId;
    this.setStatus("thinking", null);
    this.mgr.logEvent(profile.id, tickId, "tick_start", { session: profile.tick_count + 1 });

    const personality = profile.personality_id
      ? (db.prepare("SELECT name, content FROM personalities WHERE id = ?").get(profile.personality_id) as { name: string; content: string } | undefined)
      : undefined;
    const others = this.mgr.runningNames().filter((n) => n !== profile.name);
    const system = basePrompt(settings, { ...profile, personality_name: personality?.name, personality_content: personality?.content }, others, browserAvailable());

    // What's new since last time.
    const dms = db.prepare("SELECT * FROM dm_messages WHERE profile_id = ? AND sender = 'user' AND seen = 0 ORDER BY id").all(profile.id) as any[];
    if (dms.length) db.prepare("UPDATE dm_messages SET seen = 1 WHERE profile_id = ? AND sender = 'user' AND seen = 0").run(profile.id);
    const dmHistory = dms.length
      ? (db.prepare("SELECT * FROM dm_messages WHERE profile_id = ? AND id < ? ORDER BY id DESC LIMIT 6").all(profile.id, dms[0].id) as any[]).reverse()
      : [];
    const newChat = db
      .prepare("SELECT * FROM chat_messages WHERE room = 'lobby' AND id > ? AND (profile_id IS NULL OR profile_id != ?) ORDER BY id DESC LIMIT 30")
      .all(profile.last_chat_seen_id, profile.id) as any[];
    newChat.reverse();
    const maxChat = (db.prepare("SELECT MAX(id) AS m FROM chat_messages").get() as { m: number | null }).m ?? 0;
    db.prepare("UPDATE profiles SET last_chat_seen_id = ? WHERE id = ?").run(maxChat, profile.id);

    const episodes = recentEpisodes(db, profile.id, 4);
    const pinned = pinnedMemories(db, profile.id, !!profile.shared_memory);
    const exclude = new Set([...episodes, ...pinned].map((m) => m.id));
    const query = [...episodes.map((e) => e.content), ...dms.map((d) => d.content), ...newChat.map((c) => c.content)].join("\n").slice(-3000);
    const recalled = await recall(db, settings, { profileId: profile.id, includeShared: !!profile.shared_memory, query, limit: 10, excludeIds: exclude, touch: true });

    const lastTick = db.prepare("SELECT ended_at FROM ticks WHERE profile_id = ? AND id < ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1").get(profile.id, tickId) as
      | { ended_at: string }
      | undefined;
    const nameOf = (id: number | null) => this.mgr.nameOf(id);
    const fmt = (m: any) => formatMemory(m, nameOf, profile.id);

    const parts: string[] = [`[Environment update]`, `Current time: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`];
    if (!lastTick) parts.push(`This is your very first session. You have no memories yet. You have free time; do whatever you'd like.`);
    else parts.push(`This is session #${profile.tick_count + 1}. Your last session ended ${ago(Date.now() - parseDbTime(lastTick.ended_at))} ago.`);
    if (pinned.length) parts.push(`\n## Core memories\n${pinned.map(fmt).join("\n")}`);
    if (episodes.length) parts.push(`\n## Your most recent sessions\n${episodes.map(fmt).join("\n")}`);
    if (recalled.length) parts.push(`\n## Other memories that came to mind\n${recalled.map(fmt).join("\n")}`);
    if (dms.length) {
      const hist = dmHistory.map((d) => `${d.sender === "user" ? "Operator" : "You"}: ${d.content}`).join("\n");
      parts.push(
        `\n## New direct message${dms.length > 1 ? "s" : ""} from the operator\n${hist ? `(earlier conversation)\n${hist}\n(new)\n` : ""}${dms.map((d) => `Operator: ${d.content}`).join("\n")}\nReply with message_user if you want to.`,
      );
    }
    if (newChat.length) parts.push(`\n## New in the chatroom since you last looked\n${newChat.map(formatChat).join("\n")}`);
    if (profile.session_minutes > 0)
      parts.push(
        `\nThis is your time. This session lasts ${profile.session_minutes} minutes, and you can't rest before it's over, so keep doing whatever you like until then. When it ends, call rest.`,
      );
    else parts.push(`\nThis is your time. Do whatever you like, and call rest when you're done for now.`);

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: parts.join("\n") },
    ];
    this.mgr.logEvent(profile.id, tickId, "context", { system, context: parts.join("\n") });

    const tools = toolDefs(profile);
    let tokensIn = 0,
      tokensOut = 0,
      steps = 0,
      model = "";
    let restResult: { minutes: number; note: string; importance: number } | undefined;
    const actions: string[] = [];

    this.chatNotes = [];
    // With a session length, the clock decides when the session ends (steps are only a runaway guard).
    const timed = profile.session_minutes > 0;
    const sessionEnd = Date.now() + profile.session_minutes * 60_000;
    const stepCap = timed ? 500 : profile.max_steps;
    const leftText = () => {
      const m = Math.max(1, Math.ceil((sessionEnd - Date.now()) / 60_000));
      return `about ${m} minute${m === 1 ? "" : "s"}`;
    };
    const usedBefore = this.mgr.tokensToday(profile.id);
    let timeUpSent = false;
    for (; steps < stepCap && this.running && !restResult; steps++) {
      if (timed && Date.now() >= sessionEnd) {
        if (timeUpSent) break;
        messages.push({ role: "user", content: "[Environment] Your session time is up. Call rest now with your note about this session." });
        timeUpSent = true;
      }
      if (profile.daily_token_budget > 0 && usedBefore + tokensIn + tokensOut >= profile.daily_token_budget) {
        this.mgr.logEvent(profile.id, tickId, "status", { message: "Daily token budget reached mid-session; ending the session early." });
        break;
      }
      if (this.chatNotes.length) {
        const notes = this.chatNotes.splice(0);
        messages.push({ role: "user", content: `[Notification] You were mentioned in the chatroom:\n${notes.map((n) => n.line).join("\n")}` });
        db.prepare("UPDATE profiles SET last_chat_seen_id = MAX(last_chat_seen_id, ?) WHERE id = ?").run(Math.max(...notes.map((n) => n.id)), profile.id);
        this.mgr.logEvent(profile.id, tickId, "notification", { lines: notes.map((n) => n.line) });
      }
      compact(messages);
      if (!timed && steps === profile.max_steps - 1) messages.push({ role: "user", content: "[Environment] This session is almost over. You have one more action; it's a good moment to call rest." });
      const res = await chat(settings, profile.provider, profile.model, messages, tools);
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      model = res.routedVia ?? res.model;
      if (res.content?.trim()) this.mgr.logEvent(profile.id, tickId, "thought", { content: res.content, model });
      messages.push({ role: "assistant", content: res.content ?? null, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
      if (!res.toolCalls.length) {
        if (!timed || timeUpSent) break;
        // Time is left: nudge the agent on, and pause briefly so a chatty model can't spin through tokens.
        messages.push({ role: "user", content: `[Environment] ${leftText()} of this session remain. Carry on with anything you like.` });
        await sleep(15_000);
        continue;
      }

      for (const call of res.toolCalls) {
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = { _raw: call.function.arguments };
        }
        this.mgr.logEvent(profile.id, tickId, "tool_call", { id: call.id, name: call.function.name, args });
        let out: ToolOutcome;
        try {
          out = await runTool(
            { db, settings, profile, tickId, nameOf, onChatPost: (id) => this.mgr.handleChatPost(id) },
            call.function.name,
            args,
          );
        } catch (e: any) {
          out = { output: `Tool error: ${e?.message ?? e}` };
        }
        if (out.rest && timed && Date.now() < sessionEnd) {
          // Refuse, but pause first so an agent that keeps asking to rest can't burn through tokens.
          await sleep(Math.min(20_000, Math.max(0, sessionEnd - Date.now())));
          out = { output: `You can't rest yet: ${leftText()} of free time left in this session. Keep doing whatever you like.` };
        }
        actions.push(`${call.function.name}(${JSON.stringify(args).slice(0, 200)})`);
        this.mgr.logEvent(profile.id, tickId, "tool_result", { id: call.id, name: call.function.name, output: out.output.slice(0, 6000), screenshot: out.screenshot });
        messages.push({ role: "tool", tool_call_id: call.id, content: out.output });
        if (out.rest) restResult = out.rest;
      }
    }

    // If the agent didn't call rest, ask it for its session note.
    if (!restResult) {
      let note = "";
      let importance = 4;
      try {
        compact(messages);
        const res = await chat(settings, profile.provider, profile.model, [...messages, { role: "user", content: SUMMARY_PROMPT }], undefined, { temperature: 0.4 });
        tokensIn += res.tokensIn;
        tokensOut += res.tokensOut;
        const j = parseJsonLoose(res.content);
        note = j?.note ?? res.content ?? "";
        importance = Number(j?.importance) || 4;
      } catch {
        note = actions.length ? `I used: ${actions.join(", ")}.` : "A quiet session.";
      }
      restResult = { minutes: (profile.min_rest_minutes + profile.max_rest_minutes) / 4, note: String(note).slice(0, 4000), importance };
    }

    if (restResult.note.trim()) {
      await addMemory(db, settings, {
        profileId: profile.id,
        authorId: profile.id,
        scope: "private",
        kind: "episode",
        content: restResult.note,
        importance: restResult.importance,
        tickId,
      });
    }
    db.prepare(
      "UPDATE ticks SET ended_at = datetime('now'), steps = ?, tokens_in = ?, tokens_out = ?, model_used = ?, summary = ?, rest_minutes = ? WHERE id = ?",
    ).run(steps, tokensIn, tokensOut, model, restResult.note, restResult.minutes, tickId);
    db.prepare("UPDATE profiles SET tick_count = tick_count + 1 WHERE id = ?").run(profile.id);
    this.mgr.logEvent(profile.id, tickId, "tick_end", { steps, tokensIn, tokensOut, model, rest: restResult.minutes, note: restResult.note });

    const every = settings.reflectionEvery;
    if (every > 0 && (profile.tick_count + 1) % every === 0 && this.running) await this.reflect(profile, tickId).catch(() => {});
    return restResult.minutes;
  }

  private async reflect(profile: ProfileRow, tickId: number) {
    const { db } = this.mgr;
    const settings = getSettings(db);
    const recent = (db.prepare("SELECT * FROM memories WHERE profile_id = ? AND kind != 'reflection' ORDER BY id DESC LIMIT 40").all(profile.id) as any[]).reverse();
    if (recent.length < 4) return;
    const res = await chat(
      settings,
      profile.provider,
      profile.model,
      [
        { role: "system", content: `You are ${profile.name}, reflecting on your own memories.` },
        { role: "user", content: `${recent.map((m) => formatMemory(m, (id) => this.mgr.nameOf(id), profile.id)).join("\n")}\n\n${REFLECTION_PROMPT}` },
      ],
      undefined,
      { temperature: 0.5 },
    );
    const insights = parseJsonLoose(res.content)?.insights;
    if (!Array.isArray(insights)) return;
    for (const i of insights.slice(0, 5)) {
      if (!i?.content) continue;
      await addMemory(db, settings, { profileId: profile.id, authorId: profile.id, scope: "private", kind: "reflection", content: String(i.content), importance: Number(i.importance) || 7, tickId });
    }
    this.mgr.logEvent(profile.id, tickId, "reflection", { insights });
  }
}

/** Keep long sessions within small context windows: drop the oldest steps, shorten older tool outputs. */
function compact(messages: ChatMessage[]) {
  const KEEP = 40;
  if (messages.length > KEEP + 2) {
    // Cut after the system prompt and the opening context, at a point that doesn't orphan tool results.
    let cut = messages.length - KEEP;
    while (cut < messages.length && messages[cut].role === "tool") cut++;
    const dropped = messages.splice(2, cut - 2);
    const calls = dropped.flatMap((m) => (m.role === "assistant" && m.tool_calls ? m.tool_calls.map((t) => t.function.name) : []));
    messages.splice(2, 0, { role: "user", content: `[Environment] Earlier steps of this session were trimmed to save space (you used: ${calls.join(", ") || "no tools"}).` });
  }
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, -2)) {
    const m = messages[i] as { role: "tool"; content: string; tool_call_id: string };
    if (m.content.length > 1500) m.content = m.content.slice(0, 1500) + "\n…[older output shortened]";
  }
}

export class AgentManager {
  private runners = new Map<number, AgentRunner>();

  constructor(public db: DB) {}

  getProfile(id: number): ProfileRow | undefined {
    return this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as ProfileRow | undefined;
  }

  nameOf(id: number | null): string {
    if (id == null) return "unknown";
    return (this.db.prepare("SELECT name FROM profiles WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "a former agent";
  }

  tokensToday(profileId: number): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS t FROM ticks WHERE profile_id = ? AND started_at >= date('now')")
      .get(profileId) as { t: number };
    return r.t;
  }

  logEvent(profileId: number | null, tickId: number | null, type: string, data: unknown) {
    const info = this.db.prepare("INSERT INTO events (profile_id, tick_id, type, data) VALUES (?, ?, ?, ?)").run(profileId, tickId, type, JSON.stringify(data));
    bus.publish({ channel: "event", profileId, payload: { id: Number(info.lastInsertRowid), profile_id: profileId, tick_id: tickId, type, data, created_at: new Date().toISOString() } });
  }

  private runner(id: number) {
    let r = this.runners.get(id);
    if (!r) {
      r = new AgentRunner(this, id);
      this.runners.set(id, r);
    }
    return r;
  }

  start(id: number) {
    if (!this.getProfile(id)) throw new Error("No such profile");
    this.db.prepare("UPDATE profiles SET autostart = 1 WHERE id = ?").run(id);
    this.runner(id).start();
  }

  stop(id: number) {
    this.db.prepare("UPDATE profiles SET autostart = 0 WHERE id = ?").run(id);
    this.runners.get(id)?.stop();
    void closeBrowser(id);
  }

  wake(id: number) {
    const r = this.runners.get(id);
    if (r?.isRunning) r.wake();
  }

  remove(id: number) {
    this.runners.get(id)?.stop();
    void closeBrowser(id);
    this.runners.delete(id);
  }

  state(id: number): AgentState {
    return this.runners.get(id)?.state ?? { profileId: id, status: "stopped", nextWakeAt: null, currentTickId: null, lastError: null };
  }

  runningNames(): string[] {
    return [...this.runners.values()].filter((r) => r.isRunning).map((r) => this.nameOf(r.state.profileId));
  }

  /**
   * Notify agents addressed in a chatroom message (@Name, or @everyone for all of them).
   * An agent mid-session gets it before its next step. A resting agent is woken: right away
   * when the operator wrote it, otherwise no sooner than its minimum rest, so agents mentioning
   * each other can't keep each other awake in a tight loop.
   */
  handleChatPost(messageId: number) {
    if (!getSettings(this.db).wakeOnMention) return;
    const msg = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(messageId) as
      | { id: number; sender_type: string; profile_id: number | null; sender_name: string; content: string; created_at: string }
      | undefined;
    if (!msg) return;
    const lower = msg.content.toLowerCase();
    const everyone = lower.includes("@everyone");
    const line = formatChat(msg);
    for (const r of this.runners.values()) {
      if (!r.isRunning || r.state.profileId === msg.profile_id) continue;
      if (!everyone && !lower.includes("@" + this.nameOf(r.state.profileId).toLowerCase())) continue;
      if (r.notify(msg.id, line)) continue;
      if (msg.sender_type === "user") r.wake();
      else r.nudge(this.getProfile(r.state.profileId)?.min_rest_minutes ?? 2);
    }
  }

  resumeAutostart() {
    const rows = this.db.prepare("SELECT id FROM profiles WHERE autostart = 1").all() as { id: number }[];
    for (const r of rows) this.runner(r.id).start();
  }

  stopAll() {
    for (const r of this.runners.values()) r.stop();
  }
}
