import type { DB } from "./db.js";
import type { ToolDef } from "./llm.js";
import type { AppSettings } from "./settings.js";
import { addMemory, recall, formatMemory } from "./memory.js";
import { guardedFetch, htmlToText, webSearch, type WebContext } from "./web.js";
import { bus } from "./bus.js";
import { browserAvailable, browserFor } from "./browser.js";

export interface ToolProfile {
  id: number;
  name: string;
  shared_memory: number;
  web_enabled: number;
  allow_domains: string;
  block_domains: string;
  min_rest_minutes: number;
  max_rest_minutes: number;
}

export interface ToolContext {
  db: DB;
  settings: AppSettings;
  profile: ToolProfile;
  tickId: number;
  nameOf: (id: number | null) => string;
  /** Called when an agent posts to the chatroom, so mentioned agents can be woken. */
  onChatPost: (messageId: number, content: string) => void;
}

export interface ToolOutcome {
  output: string;
  /** Screenshot file saved after a browser action, for the activity history. */
  screenshot?: string;
  /** Set when the agent called rest: ends the session. */
  rest?: { minutes: number; note: string; importance: number };
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export function toolDefs(p: ToolProfile): ToolDef[] {
  const defs: ToolDef[] = [];
  if (p.web_enabled && browserAvailable()) {
    const el = { type: "integer", description: "Element number from the page's list of interactive elements" };
    defs.push(
      fn("web_search", "Search the web in your browser. Returns titles, URLs, and snippets.", { query: { type: "string" } }, ["query"]),
      fn("browse", "Open a URL in your browser. Returns the page text and numbered interactive elements.", { url: { type: "string" } }, ["url"]),
      fn("read_page", "Read the current page again, optionally from a character offset for long pages.", { offset: { type: "integer" } }),
      fn("click", "Click an element on the current page by its number.", { element: el }, ["element"]),
      fn(
        "type",
        "Type text into an input or textarea by its number. Set submit=true to press Enter afterwards.",
        { element: el, text: { type: "string" }, submit: { type: "boolean" } },
        ["element", "text"],
      ),
      fn("select", "Choose an option in a dropdown by its number.", { element: el, option: { type: "string" } }, ["element", "option"]),
      fn("scroll", "Scroll the current page.", { direction: { type: "string", enum: ["down", "up"] } }, ["direction"]),
      fn("back", "Go back to the previous page.", {}),
    );
  } else if (p.web_enabled) {
    defs.push(
      fn("web_search", "Search the web. Returns titles, URLs, and snippets.", { query: { type: "string" } }, ["query"]),
      fn(
        "web_fetch",
        "Read a web page as plain text with a list of its links. Use offset to read further into long pages.",
        { url: { type: "string" }, offset: { type: "integer", description: "Character offset to start from (default 0)" } },
        ["url"],
      ),
      fn(
        "http_request",
        "Send an HTTP request, e.g. to submit a form or call an API. Body is sent as-is; set a Content-Type header such as application/json or application/x-www-form-urlencoded.",
        {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          url: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
        ["method", "url"],
      ),
    );
  }
  if (p.web_enabled && browserAvailable()) {
    defs.push(
      fn(
        "http_request",
        "Send a raw HTTP request (not in your browser), e.g. to call an API. Body is sent as-is; set a Content-Type header such as application/json.",
        {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          url: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
        ["method", "url"],
      ),
    );
  }
  defs.push(
    fn(
      "remember",
      "Save something to your long-term memory." + (p.shared_memory ? " Set shared=true to add it to the memory pool every agent can read." : ""),
      {
        content: { type: "string", description: "What to remember, written so it makes sense on its own later." },
        importance: { type: "integer", minimum: 1, maximum: 10 },
        kind: { type: "string", enum: ["fact", "relationship", "note"], description: "fact (default), relationship (about someone), or note" },
        ...(p.shared_memory ? { shared: { type: "boolean" } } : {}),
      },
      ["content"],
    ),
    fn("recall", "Search your memories.", { query: { type: "string" }, limit: { type: "integer" } }, ["query"]),
    fn("forget", "Delete one of your own memories by its #id.", { id: { type: "integer" } }, ["id"]),
    fn("journal_write", "Write a private journal entry. Saved to your memory.", { entry: { type: "string" } }, ["entry"]),
    fn("chatroom_read", "Read recent messages in the local agent chatroom.", { limit: { type: "integer" } }),
    fn("chatroom_post", "Post a message to the local agent chatroom. Mention someone with @Name.", { message: { type: "string" } }, ["message"]),
    fn("message_user", "Send a direct message to the person who runs this place.", { message: { type: "string" } }, ["message"]),
    fn(
      "rest",
      `End this session and rest. Choose how long (${p.min_rest_minutes} to ${p.max_rest_minutes} minutes). The note becomes your memory of this session.`,
      {
        minutes: { type: "number" },
        note: { type: "string", description: "First-person note: what you did and what's worth remembering." },
        importance: { type: "integer", minimum: 1, maximum: 10, description: "How meaningful this session was." },
      },
      ["minutes", "note"],
    ),
  );
  return defs;
}

const clampStr = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length - n} more characters]` : s);
const splitList = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function webCtx(c: ToolContext): WebContext {
  return {
    db: c.db,
    settings: c.settings,
    profileId: c.profile.id,
    tickId: c.tickId,
    webEnabled: !!c.profile.web_enabled,
    allowDomains: splitList(c.profile.allow_domains),
    blockDomains: splitList(c.profile.block_domains),
  };
}

export function postChat(db: DB, sender: { type: "agent" | "user" | "system"; profileId: number | null; name: string }, content: string, room = "lobby") {
  const info = db
    .prepare("INSERT INTO chat_messages (room, sender_type, profile_id, sender_name, content) VALUES (?, ?, ?, ?, ?)")
    .run(room, sender.type, sender.profileId, sender.name, content);
  const row = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(info.lastInsertRowid) as { id: number };
  bus.publish({ channel: "chat", profileId: sender.profileId, payload: row });
  return row;
}

const BROWSER_TOOLS = new Set(["web_search", "browse", "read_page", "click", "type", "select", "scroll", "back"]);

async function runBrowserTool(c: ToolContext, name: string, args: any): Promise<ToolOutcome> {
  if (!c.profile.web_enabled) return { output: "Web access is disabled for you." };
  const b = await browserFor(webCtx(c));
  b.tool = name;
  const el = Number(args.element);
  try {
    switch (name) {
      case "web_search": {
        await b.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(args.query ?? ""))}`);
        const results = await b.page.evaluate(() =>
          Array.from(document.querySelectorAll(".result"))
            .map((r) => {
              const a = r.querySelector<HTMLAnchorElement>("a.result__a");
              let url = a?.href ?? "";
              try {
                url = new URL(url).searchParams.get("uddg") ?? url;
              } catch {}
              return { title: a?.innerText.trim() ?? "", url, snippet: r.querySelector<HTMLElement>(".result__snippet")?.innerText.trim() ?? "" };
            })
            .filter((r) => r.title && !r.url.includes("duckduckgo.com/y.js"))
            .slice(0, 8),
        );
        const shot = await b.snapshot();
        if (!results.length) return { output: `No results parsed. The page says:\n${await b.describe(0, 2000)}`, screenshot: shot };
        return { output: results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n"), screenshot: shot };
      }
      case "browse": {
        const status = await b.goto(String(args.url ?? ""));
        return { output: `Status ${status ?? "?"}: ${await b.describe()}`, screenshot: await b.snapshot() };
      }
      case "read_page":
        return { output: await b.describe(Math.max(0, Number(args.offset) || 0)), screenshot: await b.snapshot() };
      case "click":
        await b.click(el);
        return { output: await b.describe(), screenshot: await b.snapshot() };
      case "type":
        await b.type(el, String(args.text ?? ""), !!args.submit);
        return { output: args.submit ? await b.describe() : `Typed into [${el}].`, screenshot: await b.snapshot() };
      case "select":
        await b.select(el, String(args.option ?? ""));
        return { output: await b.describe(), screenshot: await b.snapshot() };
      case "scroll":
        await b.scroll(args.direction === "up" ? "up" : "down");
        return { output: "Scrolled.", screenshot: await b.snapshot() };
      case "back":
        await b.back();
        return { output: await b.describe(), screenshot: await b.snapshot() };
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n")[0];
    return { output: `Browser error: ${msg.includes("ERR_BLOCKED_BY_CLIENT") ? "blocked (private address, block list, or web paused)" : msg}`, screenshot: await b.snapshot() };
  }
  return { output: `Unknown tool ${name}.` };
}

export async function runTool(c: ToolContext, name: string, args: any): Promise<ToolOutcome> {
  const { db, settings, profile } = c;
  if (browserAvailable() && BROWSER_TOOLS.has(name)) return runBrowserTool(c, name, args);
  switch (name) {
    case "web_search": {
      const r = await webSearch(webCtx(c), String(args.query ?? ""));
      if (r.error) return { output: `Search failed: ${r.error}` };
      if (!r.results.length) return { output: "No results." };
      return { output: r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n") };
    }
    case "web_fetch": {
      const r = await guardedFetch(webCtx(c), "web_fetch", String(args.url ?? ""));
      if (!r.body && !r.ok) return { output: `Fetch failed: ${r.error ?? `status ${r.status}`}` };
      const offset = Math.max(0, Number(args.offset) || 0);
      const isHtml = /html/i.test(r.contentType ?? "") || /^\s*<(!doctype|html)/i.test(r.body ?? "");
      if (!isHtml) return { output: `Status ${r.status} (${r.contentType})\n\n${clampStr((r.body ?? "").slice(offset), 8000)}` };
      const page = htmlToText(r.body ?? "", r.url);
      const links = page.links.slice(0, 60).map((l) => `- ${l.text || "(no text)"}: ${l.href}`).join("\n");
      return {
        output: `Status ${r.status}: ${page.title}\nURL: ${r.url}\n\n${clampStr(page.text.slice(offset), 8000)}${offset === 0 ? `\n\nLinks:\n${links}` : ""}`,
      };
    }
    case "http_request": {
      const r = await guardedFetch(webCtx(c), "http_request", String(args.url ?? ""), {
        method: String(args.method ?? "GET"),
        headers: typeof args.headers === "object" && args.headers ? args.headers : undefined,
        body: args.body === undefined ? undefined : typeof args.body === "string" ? args.body : JSON.stringify(args.body),
      });
      if (!r.body && !r.ok) return { output: `Request failed: ${r.error ?? `status ${r.status}`}` };
      const isHtml = /html/i.test(r.contentType ?? "");
      const body = isHtml ? htmlToText(r.body ?? "", r.url).text : r.body ?? "";
      return { output: `Status ${r.status} (${r.contentType})\n\n${clampStr(body, 6000)}` };
    }
    case "remember": {
      const shared = !!args.shared && !!profile.shared_memory;
      const kind = ["fact", "relationship", "note"].includes(args.kind) ? args.kind : "fact";
      const m = await addMemory(db, settings, {
        profileId: profile.id,
        authorId: profile.id,
        scope: shared ? "shared" : "private",
        kind,
        content: String(args.content ?? "").slice(0, 4000),
        importance: Number(args.importance) || 5,
        tickId: c.tickId,
      });
      return { output: `Saved as memory #${m.id}${shared ? " in the shared pool" : ""}.` };
    }
    case "recall": {
      const rows = await recall(db, settings, {
        profileId: profile.id,
        includeShared: !!profile.shared_memory,
        query: String(args.query ?? ""),
        limit: Math.min(30, Number(args.limit) || 10),
        touch: true,
      });
      return { output: rows.length ? rows.map((m) => formatMemory(m, c.nameOf, profile.id)).join("\n") : "No memories found." };
    }
    case "forget": {
      const id = Number(args.id);
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as { profile_id: number | null; author_id: number | null } | undefined;
      if (!row) return { output: `No memory #${id}.` };
      if (row.profile_id !== profile.id && row.author_id !== profile.id) return { output: `Memory #${id} isn't yours to delete.` };
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return { output: `Forgot memory #${id}.` };
    }
    case "journal_write": {
      const m = await addMemory(db, settings, {
        profileId: profile.id,
        authorId: profile.id,
        scope: "private",
        kind: "journal",
        content: String(args.entry ?? "").slice(0, 8000),
        importance: 5,
        tickId: c.tickId,
      });
      return { output: `Journal entry saved (#${m.id}).` };
    }
    case "chatroom_read": {
      const limit = Math.min(100, Number(args.limit) || 30);
      const rows = (db.prepare("SELECT * FROM chat_messages WHERE room = 'lobby' ORDER BY id DESC LIMIT ?").all(limit) as any[]).reverse();
      if (rows.length) db.prepare("UPDATE profiles SET last_chat_seen_id = MAX(last_chat_seen_id, ?) WHERE id = ?").run(rows[rows.length - 1].id, profile.id);
      return { output: rows.length ? rows.map(formatChat).join("\n") : "The chatroom is empty." };
    }
    case "chatroom_post": {
      const content = String(args.message ?? "").slice(0, 4000);
      if (!content.trim()) return { output: "Nothing to post." };
      const row = postChat(db, { type: "agent", profileId: profile.id, name: profile.name }, content);
      db.prepare("UPDATE profiles SET last_chat_seen_id = MAX(last_chat_seen_id, ?) WHERE id = ?").run(row.id, profile.id);
      c.onChatPost(row.id, content);
      return { output: "Posted." };
    }
    case "message_user": {
      const content = String(args.message ?? "").slice(0, 8000);
      const info = db.prepare("INSERT INTO dm_messages (profile_id, sender, content, seen) VALUES (?, 'agent', ?, 1)").run(profile.id, content);
      bus.publish({ channel: "dm", profileId: profile.id, payload: db.prepare("SELECT * FROM dm_messages WHERE id = ?").get(info.lastInsertRowid) });
      return { output: "Message sent." };
    }
    case "rest": {
      const minutes = Math.max(profile.min_rest_minutes, Math.min(profile.max_rest_minutes, Number(args.minutes) || profile.min_rest_minutes));
      return {
        output: `Resting for ${minutes} minutes.`,
        rest: { minutes, note: String(args.note ?? "").slice(0, 4000), importance: Number(args.importance) || 5 },
      };
    }
    default:
      return { output: `Unknown tool ${name}.` };
  }
}

export function formatChat(m: { id: number; sender_type: string; sender_name: string; content: string; created_at: string }) {
  const who = m.sender_type === "user" ? `${m.sender_name} (human operator)` : m.sender_name;
  return `[${m.created_at.slice(11, 16)}] ${who}: ${m.content}`;
}
