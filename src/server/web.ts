import dns from "node:dns/promises";
import net from "node:net";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import type { DB } from "./db.js";
import type { AppSettings } from "./settings.js";
import { bus } from "./bus.js";

export interface WebContext {
  db: DB;
  settings: AppSettings;
  profileId: number;
  tickId: number | null;
  webEnabled: boolean;
  allowDomains: string[];
  blockDomains: string[];
}

export const UA = "AgentFreeTime/0.1 (+https://github.com/jrhampton/agent-freetime; autonomous AI agent)";
const MAX_BYTES = 2_000_000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^\*\./, "");
  return !!p && (host === p || host.endsWith("." + p));
}

function rokosHost(settings: AppSettings): string | null {
  try {
    return settings.rokosCarnivalUrl ? new URL(settings.rokosCarnivalUrl).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Returns a reason string when the URL must not be fetched. */
export async function checkUrl(ctx: WebContext, url: URL): Promise<string | null> {
  if (!["http:", "https:"].includes(url.protocol)) return "only http and https URLs are allowed";
  if (ctx.settings.webPaused) return "web access is paused by the operator";
  if (!ctx.webEnabled) return "web access is disabled for this agent";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (ctx.blockDomains.some((d) => hostMatches(host, d))) return `${host} is on this agent's block list`;
  if (ctx.allowDomains.length && !ctx.allowDomains.some((d) => hostMatches(host, d)) && host !== rokosHost(ctx.settings))
    return `${host} is not on this agent's allow list`;

  // Never let agents reach the LLM router or other services on the private network,
  // except hosts the operator explicitly trusts (Roko's Carnival is trusted automatically).
  const trusted = [rokosHost(ctx.settings), ...ctx.settings.privateHostAllowlist].filter(Boolean) as string[];
  if (trusted.some((t) => hostMatches(host, t))) return null;
  const llmHosts = Object.values(ctx.settings.providers).map((p) => {
    try {
      return new URL(p.baseUrl).host.toLowerCase();
    } catch {
      return "";
    }
  });
  if (llmHosts.includes(url.host.toLowerCase())) return "that address is the harness's own LLM provider";
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) return `could not resolve ${host}`;
  if (addrs.some(isPrivateIp)) return `${host} resolves to a private network address`;
  return null;
}

export function logRequest(ctx: WebContext, r: { tool: string; method: string; url: string; status?: number; bytes?: number; ms?: number; blocked?: boolean; error?: string }) {
  let domain = "";
  try {
    domain = new URL(r.url).hostname;
  } catch {}
  const info = ctx.db
    .prepare(
      `INSERT INTO web_requests (profile_id, tick_id, tool, method, url, domain, status, bytes, duration_ms, blocked, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.profileId, ctx.tickId, r.tool, r.method, r.url.slice(0, 2000), domain, r.status ?? null, r.bytes ?? null, r.ms ?? null, r.blocked ? 1 : 0, r.error ?? null);
  const row = ctx.db.prepare("SELECT * FROM web_requests WHERE id = ?").get(info.lastInsertRowid);
  bus.publish({ channel: "web", profileId: ctx.profileId, payload: row });
}

export interface FetchResult {
  ok: boolean;
  status?: number;
  url: string;
  contentType?: string;
  body?: string;
  error?: string;
}

/** Fetch with redirects followed manually so every hop is checked and logged. */
export async function guardedFetch(
  ctx: WebContext,
  tool: string,
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, url: rawUrl, error: "invalid URL" };
  }
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; hop < 6; hop++) {
    const reason = await checkUrl(ctx, url);
    if (reason) {
      logRequest(ctx, { tool, method, url: url.href, blocked: true, error: reason });
      return { ok: false, url: url.href, error: `blocked: ${reason}` };
    }
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: { "User-Agent": UA, Accept: "text/html,application/json,text/plain,*/*;q=0.8", ...init.headers },
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        logRequest(ctx, { tool, method, url: url.href, status: res.status, bytes: 0, ms: Date.now() - started });
        url = new URL(loc, url);
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const text = await readCapped(res);
      logRequest(ctx, { tool, method, url: url.href, status: res.status, bytes: Buffer.byteLength(text), ms: Date.now() - started });
      return { ok: res.ok, status: res.status, url: url.href, contentType: res.headers.get("content-type") ?? "", body: text };
    } catch (e: any) {
      const error = e?.name === "TimeoutError" ? "timed out" : String(e?.cause?.code ?? e?.message ?? e);
      logRequest(ctx, { tool, method, url: url.href, ms: Date.now() - started, error });
      return { ok: false, url: url.href, error };
    }
  }
  return { ok: false, url: url.href, error: "too many redirects" };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Turn HTML into readable text plus a list of links, so small-context models can browse. */
export function htmlToText(html: string, baseUrl: string): { title: string; text: string; links: { text: string; href: string }[] } {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll("script,style,noscript,svg,iframe,template").forEach((el) => el.remove());
  const title = root.querySelector("title")?.text.trim() ?? "";
  const links: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    try {
      const href = new URL(a.getAttribute("href")!, baseUrl).href;
      if (!/^https?:/.test(href) || seen.has(href)) continue;
      seen.add(href);
      links.push({ text: a.text.replace(/\s+/g, " ").trim().slice(0, 80), href });
    } catch {}
  }
  const main = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  const text = blockText(main as HTMLElement)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text, links };
}

const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "li", "ul", "ol", "tr", "table", "br", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "form", "main", "nav"]);

function blockText(el: HTMLElement): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.rawText.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    else if (node.nodeType === 1) {
      const child = node as HTMLElement;
      const tag = child.tagName?.toLowerCase() ?? "";
      const inner = blockText(child);
      if (/^h[1-6]$/.test(tag)) out += `\n\n${"#".repeat(Number(tag[1]))} ${inner.trim()}\n`;
      else if (tag === "li") out += `\n- ${inner.trim()}`;
      else if (tag === "input" || tag === "textarea" || tag === "select") {
        const name = child.getAttribute("name");
        if (name) out += ` [${tag} name="${name}"${child.getAttribute("type") ? ` type="${child.getAttribute("type")}"` : ""}] `;
      } else if (BLOCK.has(tag)) out += `\n${inner}\n`;
      else out += inner;
    }
  }
  return out;
}

export async function webSearch(ctx: WebContext, query: string): Promise<{ results: { title: string; url: string; snippet: string }[]; error?: string }> {
  const res = await guardedFetch(ctx, "web_search", "https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok || !res.body) return { results: [], error: res.error ?? `search failed with status ${res.status}` };
  const root = parseHtml(res.body);
  const results: { title: string; url: string; snippet: string }[] = [];
  for (const r of root.querySelectorAll(".result")) {
    const a = r.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") ?? "";
    try {
      const u = new URL(href, "https://duckduckgo.com");
      href = u.searchParams.get("uddg") ?? u.href;
    } catch {}
    if (href.includes("duckduckgo.com/y.js")) continue; // ads
    results.push({ title: a.text.trim(), url: href, snippet: r.querySelector(".result__snippet")?.text.trim() ?? "" });
    if (results.length >= 8) break;
  }
  return { results };
}
