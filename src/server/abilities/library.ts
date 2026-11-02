import fs from "node:fs";
import { guardedFetch, type WebContext } from "../web.js";
import { resolveIn, writeFileIn } from "./workspace.js";

/**
 * Read-only libraries with public, keyless APIs. Every request goes through the same guard and log
 * as the agent's browsing, so the web monitor shows them and per-agent block lists apply.
 */

const CHUNK = 6000;

async function getJson(ctx: WebContext, tool: string, url: string): Promise<any> {
  const r = await guardedFetch(ctx, tool, url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(r.error ?? `status ${r.status}`);
  try {
    return JSON.parse(r.body ?? "");
  } catch {
    throw new Error("the service sent something that isn't JSON");
  }
}

const stripTags = (s: string) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function page(text: string, offset: number, label: string) {
  const slice = text.slice(offset, offset + CHUNK);
  const more = text.length > offset + CHUNK ? `\n\n…[${text.length - offset - CHUNK} more characters; continue with offset ${offset + CHUNK}]` : "\n\n[end]";
  return `${label}\n\n${slice}${more}`;
}

// ---------------------------------------------------------------- Wikipedia

export async function wikiSearch(ctx: WebContext, query: string): Promise<string> {
  const j = await getJson(ctx, "wiki_search", `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(query)}`);
  const hits = j?.query?.search ?? [];
  if (!hits.length) return "No articles found.";
  return hits.map((h: any, i: number) => `${i + 1}. ${h.title}\n   ${stripTags(h.snippet)}`).join("\n");
}

export async function wikiRead(ctx: WebContext, title: string, offset = 0): Promise<string> {
  const j = await getJson(
    ctx,
    "wiki_read",
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`,
  );
  const pages = Object.values(j?.query?.pages ?? {}) as any[];
  const p = pages[0];
  if (!p || p.missing !== undefined || !p.extract) return `No article called "${title}". Try wiki_search.`;
  return page(p.extract.replace(/\n{3,}/g, "\n\n"), Math.max(0, offset), `# ${p.title}`);
}

// ---------------------------------------------------------------- Project Gutenberg

export async function booksSearch(ctx: WebContext, query: string): Promise<string> {
  const j = await getJson(ctx, "books_search", `https://gutendex.com/books/?search=${encodeURIComponent(query)}`);
  const books = (j?.results ?? []).slice(0, 10);
  if (!books.length) return "No books found.";
  return books
    .map((b: any) => `#${b.id} ${b.title} by ${(b.authors ?? []).map((a: any) => a.name).join("; ") || "unknown"} (${(b.languages ?? []).join(", ")})`)
    .join("\n");
}

const BOOKMARKS = "books/bookmarks.json";

function bookmarks(root: string): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(resolveIn(root, BOOKMARKS), "utf8"));
  } catch {
    return {};
  }
}

/** Gutenberg books are big; cache the text in the agent's workspace so later chunks cost nothing. */
export async function bookRead(ctx: WebContext, root: string, id: number, offset?: number): Promise<string> {
  if (!Number.isInteger(id) || id <= 0) return "Give a book number from books_search.";
  const cachePath = `books/${id}.txt`;
  let text: string;
  try {
    text = fs.readFileSync(resolveIn(root, cachePath), "utf8");
  } catch {
    const r = await guardedFetch(ctx, "book_read", `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`);
    if (!r.ok || !r.body) return `Couldn't fetch book #${id}: ${r.error ?? `status ${r.status}`}`;
    text = r.body.replace(/\r/g, "");
    const start = text.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/);
    const end = text.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/);
    if (start >= 0) text = text.slice(text.indexOf("\n", start) + 1, end > start ? end : undefined);
    writeFileIn(root, cachePath, text);
  }
  const marks = bookmarks(root);
  const at = offset === undefined || offset === null ? (marks[id] ?? 0) : Math.max(0, Number(offset) || 0);
  marks[id] = Math.min(text.length, at + CHUNK);
  writeFileIn(root, BOOKMARKS, JSON.stringify(marks, null, 2));
  const pct = Math.round((Math.min(text.length, at + CHUNK) / text.length) * 100);
  return page(text, at, `Book #${id}, from character ${at} (${pct}% through after this chunk). Your bookmark moves on automatically; call book_read with just the id to continue.`);
}

// ---------------------------------------------------------------- arXiv

export async function arxivSearch(ctx: WebContext, query: string): Promise<string> {
  const r = await guardedFetch(ctx, "arxiv_search", `https://export.arxiv.org/api/query?max_results=8&sortBy=relevance&search_query=all:${encodeURIComponent(query)}`);
  if (!r.ok) return `arXiv search failed: ${r.error ?? `status ${r.status}`}`;
  const entries = [...(r.body ?? "").matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  if (!entries.length) return "No papers found.";
  return entries
    .map((e, i) => {
      const tag = (t: string) => stripTags(e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "");
      const authors = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]).slice(0, 4);
      return `${i + 1}. ${tag("title")}\n   ${authors.join(", ")}${authors.length === 4 ? " et al." : ""} · ${tag("published").slice(0, 10)} · ${tag("id")}\n   ${tag("summary").slice(0, 900)}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------- Museums

export async function museumSearch(ctx: WebContext, museum: string, query: string): Promise<string> {
  if (museum === "met") {
    const s = await getJson(ctx, "museum_search", `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(query)}`);
    const ids: number[] = (s?.objectIDs ?? []).slice(0, 6);
    if (!ids.length) return "Nothing found at the Met.";
    const objs = await Promise.all(ids.map((id) => getJson(ctx, "museum_search", `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`).catch(() => null)));
    return objs
      .filter(Boolean)
      .map((o: any) => `met:${o.objectID} ${o.title} · ${o.artistDisplayName || "unknown artist"} · ${o.objectDate} · ${o.medium}\n   ${o.department}${o.culture ? `, ${o.culture}` : ""}`)
      .join("\n");
  }
  const j = await getJson(
    ctx,
    "museum_search",
    `https://api.artic.edu/api/v1/artworks/search?limit=8&fields=id,title,artist_display,date_display,medium_display&q=${encodeURIComponent(query)}`,
  );
  const rows = j?.data ?? [];
  if (!rows.length) return "Nothing found at the Art Institute of Chicago.";
  return rows.map((a: any) => `aic:${a.id} ${a.title} · ${(a.artist_display ?? "").replace(/\n/g, ", ")} · ${a.date_display} · ${a.medium_display}`).join("\n");
}

export async function museumObject(ctx: WebContext, ref: string): Promise<string> {
  const [museum, idRaw] = String(ref ?? "").split(":");
  const id = Number(idRaw);
  if (!Number.isInteger(id)) return 'Give an id like "aic:27992" or "met:436535" from museum_search.';
  if (museum === "met") {
    const o = await getJson(ctx, "museum_object", `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
    return [
      `${o.title}`,
      `${o.artistDisplayName || "Unknown artist"}${o.artistDisplayBio ? ` (${o.artistDisplayBio})` : ""}`,
      `${o.objectDate} · ${o.medium} · ${o.dimensions}`,
      `${o.department}${o.culture ? ` · ${o.culture}` : ""}${o.period ? ` · ${o.period}` : ""}`,
      o.creditLine,
      o.primaryImage ? `Image: ${o.primaryImage}` : "",
      o.objectURL ? `Page: ${o.objectURL}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const j = await getJson(
    ctx,
    "museum_object",
    `https://api.artic.edu/api/v1/artworks/${id}?fields=id,title,artist_display,date_display,medium_display,dimensions,description,place_of_origin,credit_line,image_id`,
  );
  const a = j?.data;
  if (!a) return "Not found.";
  return [
    a.title,
    (a.artist_display ?? "").replace(/\n/g, ", "),
    `${a.date_display} · ${a.medium_display} · ${a.dimensions ?? ""}`,
    a.place_of_origin,
    a.credit_line,
    a.description ? `\n${stripTags(a.description)}` : "",
    a.image_id ? `Image: https://www.artic.edu/iiif/2/${a.image_id}/full/843,/0/default.jpg` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- Sky

/** Moon phase from the date alone (synodic month from a known new moon). Good to within a day. */
export function moonPhase(date = new Date()): { name: string; illumination: number; age: number } {
  const synodic = 29.530588853;
  const knownNew = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((date.getTime() - knownNew) / 86_400_000) % synodic + synodic) % synodic;
  const illumination = Math.round(((1 - Math.cos((2 * Math.PI * age) / synodic)) / 2) * 100);
  const names = ["new moon", "waxing crescent", "first quarter", "waxing gibbous", "full moon", "waning gibbous", "last quarter", "waning crescent"];
  return { name: names[Math.floor(((age + synodic / 16) / synodic) * 8) % 8], illumination, age: Math.round(age * 10) / 10 };
}

export async function skyToday(ctx: WebContext): Promise<string> {
  const m = moonPhase();
  const lines = [`Moon: ${m.name}, ${m.illumination}% lit, ${m.age} days since new moon.`];
  try {
    const a = await getJson(ctx, "sky_today", "https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY");
    lines.push("", `NASA Astronomy Picture of the Day (${a.date}): ${a.title}`, a.explanation, a.copyright ? `Credit: ${String(a.copyright).trim()}` : "", a.url ? `Image: ${a.url}` : "");
  } catch (e: any) {
    lines.push("", `(Couldn't reach NASA's picture of the day: ${e.message})`);
  }
  return lines.filter((l) => l !== undefined).join("\n");
}
