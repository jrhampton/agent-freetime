import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { config } from "./config.js";
import { bus } from "./bus.js";
import { checkUrl, logRequest, UA, type WebContext } from "./web.js";

/**
 * Each agent gets its own browser context (its own cookies, so logins persist between sessions)
 * in one shared headless Chromium. Every request goes through the same guard as plain fetches,
 * page loads are logged, and the screen is streamed so the operator can watch.
 */

export interface ScreenFrame {
  profileId: number;
  image: string; // base64 jpeg
  url: string;
  title: string;
  at: number;
}

const VIEWPORT = { width: 1280, height: 800 };
const SHOTS_PER_AGENT = 400;

let browserPromise: Promise<Browser> | null = null;
let available: boolean | null = null;

function launch(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      .then((b) => {
        available = true;
        b.on("disconnected", () => {
          browserPromise = null;
          sessions.clear();
        });
        return b;
      })
      .catch((e) => {
        available = false;
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

/** Try launching once at startup so tools can fall back to plain fetch if Chromium is missing. */
export async function probeBrowser(log: (m: string) => void): Promise<boolean> {
  try {
    await launch();
    return true;
  } catch (e: any) {
    log(`Chromium unavailable, agents will browse with plain fetch instead: ${String(e?.message ?? e).split("\n")[0]}`);
    return false;
  }
}

export const browserAvailable = () => available === true;

const latest = new Map<number, ScreenFrame>();
export const latestFrame = (profileId: number) => latest.get(profileId);

export interface Element {
  n: number;
  tag: string;
  text: string;
  type?: string;
  href?: string;
}

export class AgentBrowser {
  ctx!: BrowserContext;
  page!: Page;
  private cdp: CDPSession | null = null;
  /** Updated by each tool call so logged requests land on the right session. */
  web: WebContext;
  tool = "browser";

  constructor(web: WebContext) {
    this.web = web;
  }

  private statePath() {
    return path.join(config.dataDir, "browser", `${this.web.profileId}.json`);
  }

  async open() {
    const browser = await launch();
    const state = fs.existsSync(this.statePath()) ? this.statePath() : undefined;
    this.ctx = await browser.newContext({ viewport: VIEWPORT, userAgent: UA + " Chrome", storageState: state, acceptDownloads: false });
    await this.ctx.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (/^(data|blob|about):/.test(url)) return route.continue();
      let reason: string | null;
      try {
        reason = await checkUrl(this.web, new URL(url));
      } catch {
        reason = "invalid URL";
      }
      if (reason) {
        if (req.isNavigationRequest()) logRequest(this.web, { tool: this.tool, method: req.method(), url, blocked: true, error: reason });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    this.page = await this.ctx.newPage();
    this.page.on("response", (res) => {
      const req = res.request();
      if (!req.isNavigationRequest() || req.frame() !== this.page.mainFrame()) return;
      const t = req.timing();
      logRequest(this.web, {
        tool: this.tool,
        method: req.method(),
        url: res.url(),
        status: res.status(),
        bytes: Number(res.headers()["content-length"]) || undefined,
        ms: t.responseEnd > 0 ? Math.round(t.responseEnd) : undefined,
      });
    });
    // Popups open in the agent's one tab instead, so the operator sees everything in one place.
    this.ctx.on("page", async (p) => {
      if (p === this.page) return;
      const url = p.url();
      await p.close().catch(() => {});
      if (url && url !== "about:blank") await this.page.goto(url).catch(() => {});
    });
    this.page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await this.startScreencast();
  }

  private async startScreencast() {
    this.cdp = await this.ctx.newCDPSession(this.page);
    let lastPublish = 0;
    this.cdp.on("Page.screencastFrame", async (f: any) => {
      this.cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      const frame: ScreenFrame = { profileId: this.web.profileId, image: f.data, url: this.page.url(), title: "", at: Date.now() };
      latest.set(this.web.profileId, frame);
      if (Date.now() - lastPublish < 250) return;
      lastPublish = Date.now();
      frame.title = await this.page.title().catch(() => "");
      bus.publish({ channel: "screen", profileId: this.web.profileId, payload: frame });
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  }

  async close() {
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
      await this.ctx.storageState({ path: this.statePath() });
    } catch {}
    await this.ctx.close().catch(() => {});
    latest.delete(this.web.profileId);
  }

  private async settle() {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  }

  async goto(url: string) {
    let u = url.trim();
    if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
    const res = await this.page.goto(u, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.settle();
    return res?.status() ?? null;
  }

  async click(n: number) {
    await this.page.locator(`[data-aft="${n}"]`).first().click({ timeout: 10_000 });
    await this.page.waitForTimeout(400);
    await this.settle();
  }

  async type(n: number, text: string, submit: boolean) {
    const loc = this.page.locator(`[data-aft="${n}"]`).first();
    await loc.fill(text, { timeout: 10_000 });
    if (submit) {
      await loc.press("Enter");
      await this.page.waitForTimeout(400);
      await this.settle();
    }
  }

  async select(n: number, value: string) {
    await this.page.locator(`[data-aft="${n}"]`).first().selectOption({ label: value }, { timeout: 10_000 }).catch(async () => {
      await this.page.locator(`[data-aft="${n}"]`).first().selectOption(value, { timeout: 5_000 });
    });
    await this.settle();
  }

  async scroll(direction: "up" | "down") {
    await this.page.mouse.wheel(0, direction === "down" ? VIEWPORT.height * 0.8 : -VIEWPORT.height * 0.8);
    await this.page.waitForTimeout(300);
  }

  async back() {
    await this.page.goBack({ timeout: 15_000 }).catch(() => {});
    await this.settle();
  }

  /** Page text plus numbered interactive elements the agent can click or type into. */
  async describe(offset = 0, maxChars = 7000): Promise<string> {
    const snap = await this.page.evaluate(() => {
      const sel = "a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [onclick], summary";
      document.querySelectorAll("[data-aft]").forEach((el) => el.removeAttribute("data-aft"));
      const out: { n: number; tag: string; text: string; type?: string; href?: string }[] = [];
      let n = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
        n++;
        el.setAttribute("data-aft", String(n));
        const input = el as HTMLInputElement;
        const label =
          el.getAttribute("aria-label") ||
          (el as HTMLInputElement).placeholder ||
          el.getAttribute("title") ||
          (el.innerText || input.value || el.getAttribute("name") || "").trim();
        out.push({
          n,
          tag: el.tagName.toLowerCase(),
          text: label.replace(/\s+/g, " ").slice(0, 80),
          type: el.tagName === "INPUT" ? input.type : undefined,
          href: el.tagName === "A" ? (el as HTMLAnchorElement).href : undefined,
        });
        if (n >= 150) break;
      }
      return { title: document.title, text: document.body?.innerText ?? "", elements: out };
    });
    const text = snap.text.replace(/\n{3,}/g, "\n\n").trim();
    const slice = text.slice(offset, offset + maxChars);
    const more = text.length > offset + maxChars ? `\n…[${text.length - offset - maxChars} more characters; read_page with offset ${offset + maxChars}]` : "";
    const els = snap.elements
      .map((e) => `[${e.n}] ${e.tag}${e.type ? `(${e.type})` : ""} ${e.text || "(no label)"}${e.href ? ` → ${e.href}` : ""}`)
      .join("\n");
    return `${snap.title}\nURL: ${this.page.url()}\n\n${slice}${more}\n\nInteractive elements (use the number with click/type):\n${els || "(none)"}`;
  }

  /** Saves a screenshot for the activity history; returns its file name. */
  async snapshot(): Promise<string | undefined> {
    try {
      const dir = path.join(config.dataDir, "screens", String(this.web.profileId));
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}.jpg`;
      await this.page.screenshot({ path: path.join(dir, name), type: "jpeg", quality: 60 });
      const files = fs.readdirSync(dir).sort();
      for (const f of files.slice(0, Math.max(0, files.length - SHOTS_PER_AGENT))) fs.rmSync(path.join(dir, f), { force: true });
      return name;
    } catch {
      return undefined;
    }
  }
}

const sessions = new Map<number, Promise<AgentBrowser>>();

export async function browserFor(web: WebContext): Promise<AgentBrowser> {
  let s = sessions.get(web.profileId);
  if (!s) {
    s = (async () => {
      const b = new AgentBrowser(web);
      await b.open();
      return b;
    })();
    sessions.set(web.profileId, s);
    s.catch(() => sessions.delete(web.profileId));
  }
  const b = await s;
  b.web = web;
  return b;
}

export async function closeBrowser(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  sessions.delete(profileId);
  await (await s.catch(() => null))?.close();
  bus.publish({ channel: "screen", profileId, payload: null });
}

export function screenshotPath(profileId: number, file: string): string | null {
  if (!/^\d+\.jpg$/.test(file)) return null;
  const p = path.join(config.dataDir, "screens", String(profileId), file);
  return fs.existsSync(p) ? p : null;
}
