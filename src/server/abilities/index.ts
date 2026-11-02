import fs from "node:fs";
import type { DB } from "../db.js";
import type { ToolDef } from "../llm.js";
import { headersFor } from "../llm.js";
import type { AppSettings } from "../settings.js";
import type { WebContext } from "../web.js";
import { bus } from "../bus.js";
import { byId, CATALOG, customSkillKey, parseAbilities, type Ability, type CustomSkill } from "./catalog.js";
import { detect, recipeById } from "./software.js";
import { listFiles, resolveIn, slug, TEXT_EXTENSIONS, TEXT_FILE_LIMIT, workspaceRoot, writeFileIn } from "./workspace.js";
import * as apps from "./apps.js";
import * as lib from "./library.js";

/** Per-session state: which toolbox the agent has open. */
export interface AbilitySession {
  toolbox: string | null;
}

export interface AbilityProfile {
  id: number;
  name: string;
  abilities: string;
  web_enabled: number;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const SCENE_SCHEMA = {
  type: "object",
  description:
    "Units are meters; z is up. Shapes are about 1 unit across before scaling. Rotation is in degrees [x, y, z]. Colors are hex like #e5322d.",
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          shape: { type: "string", enum: ["cube", "sphere", "cylinder", "cone", "torus", "plane", "monkey", "ico", "text"] },
          text: { type: "string", description: "For shape=text" },
          location: { type: "array", items: { type: "number" } },
          rotation: { type: "array", items: { type: "number" } },
          scale: { description: "A number, or [x, y, z]" },
          color: { type: "string" },
          metallic: { type: "number", description: "0 to 1" },
          roughness: { type: "number", description: "0 to 1" },
          emission: { type: "number", description: "Glow strength, 0 for none" },
          transparency: { type: "number", description: "0 to 1, glass-like" },
        },
        required: ["shape"],
      },
    },
    lights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["sun", "point", "area", "spot"] },
          location: { type: "array", items: { type: "number" } },
          rotation: { type: "array", items: { type: "number" } },
          energy: { type: "number", description: "Sun: 1-10. Point/area/spot: watts, e.g. 500" },
          color: { type: "string" },
        },
      },
    },
    camera: {
      type: "object",
      properties: { location: { type: "array", items: { type: "number" } }, look_at: { type: "array", items: { type: "number" } }, lens: { type: "number" } },
    },
    background: { type: "string" },
    resolution: { type: "array", items: { type: "integer" } },
    samples: { type: "integer", description: "Render quality, 16-128. Higher is slower." },
  },
  required: ["objects"],
};

/** The tools each ability puts in the agent's hands when its toolbox is open. */
function toolsFor(id: string): ToolDef[] {
  switch (id) {
    case "writing-desk":
      return [
        fn("desk_list", "List the files on your writing desk (your workspace folder), optionally inside one folder.", { folder: { type: "string" } }),
        fn("desk_read", "Read a text file from your writing desk.", { path: { type: "string" }, offset: { type: "integer" } }, ["path"]),
        fn(
          "desk_write",
          `Write a text file on your writing desk (${TEXT_EXTENSIONS.join(", ")}). Folders are created as needed. Set append=true to add to the end instead of replacing.`,
          { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean" } },
          ["path", "content"],
        ),
      ];
    case "sketchbook":
      return [
        fn(
          "sketch_draw",
          "Save a drawing written as SVG to your sketchbook. Give it a name. Use a viewBox; no scripts or external images. The person sees it in your gallery.",
          { name: { type: "string" }, svg: { type: "string" } },
          ["name", "svg"],
        ),
      ];
    case "paint":
      return [fn("paint", "Make an image from a written description and save it to your gallery. Uses the free image quota.", { name: { type: "string" }, prompt: { type: "string" } }, ["name", "prompt"])];
    case "blender":
      return [
        fn(
          "blender_render",
          "Build a 3D scene in Blender from shapes, lights and a camera, and render it to an image in your gallery. The scene is also saved as JSON next to it, so you can read it back and change it.",
          { name: { type: "string" }, scene: SCENE_SCHEMA },
          ["name", "scene"],
        ),
      ];
    case "score":
      return [
        fn(
          "score_engrave",
          'Engrave music written in LilyPond notation into sheet music (PNG and PDF). Add a \\midi { } block inside \\score for a MIDI file. Example: \\score { \\relative c\' { c4 d e f | g1 } \\layout { } \\midi { } }. Scheme expressions like #( ... ) are not allowed.',
          { name: { type: "string" }, lilypond: { type: "string" } },
          ["name", "lilypond"],
        ),
      ];
    case "text-adventures":
      return [
        fn("adventure_games", "List the text adventures on the shelf.", {}),
        fn("adventure_start", "Start or resume a text adventure. Your progress is kept between sessions; set fresh=true to start over.", { game: { type: "string" }, fresh: { type: "boolean" } }, ["game"]),
        fn("adventure_command", "Type a command into the running game, like LOOK, GO NORTH or TAKE LAMP.", { command: { type: "string" } }, ["command"]),
      ];
    case "chess":
      return [
        fn("chess_new", "Start a new chess game against Stockfish.", { play_as: { type: "string", enum: ["white", "black"] }, strength: { type: "integer", minimum: 0, maximum: 20 } }),
        fn("chess_move", "Make a move in coordinate notation, like e2e4 (or e7e8q to promote). The engine replies.", { move: { type: "string" } }, ["move"]),
        fn("chess_board", "Show the board and whose move it is.", {}),
      ];
    case "wikipedia":
      return [
        fn("wiki_search", "Search Wikipedia.", { query: { type: "string" } }, ["query"]),
        fn("wiki_read", "Read a Wikipedia article as plain text. Use offset to continue long articles.", { title: { type: "string" }, offset: { type: "integer" } }, ["title"]),
      ];
    case "gutenberg":
      return [
        fn("books_search", "Search Project Gutenberg's public-domain books by title or author.", { query: { type: "string" } }, ["query"]),
        fn("book_read", "Read the next part of a book by its number. Your place is bookmarked automatically.", { id: { type: "integer" }, offset: { type: "integer" } }, ["id"]),
      ];
    case "arxiv":
      return [fn("arxiv_search", "Search arXiv research papers. Returns titles, authors and abstracts.", { query: { type: "string" } }, ["query"])];
    case "museums":
      return [
        fn("museum_search", "Search a museum's collection: aic (Art Institute of Chicago) or met (the Met).", { museum: { type: "string", enum: ["aic", "met"] }, query: { type: "string" } }, ["query"]),
        fn("museum_object", 'Read the label and details of one work, by an id like "aic:27992" from museum_search.', { id: { type: "string" } }, ["id"]),
      ];
    case "sky":
      return [fn("sky_today", "Tonight's moon phase and NASA's astronomy picture of the day.", {})];
  }
  return [];
}

const TOOL_OWNER = new Map<string, string>();
for (const a of CATALOG) for (const t of toolsFor(a.id)) TOOL_OWNER.set(t.function.name, a.id);
export const isAbilityTool = (name: string) => TOOL_OWNER.has(name) || name === "open_toolbox" || name === "wish_for";

export function customSkills(db: DB): CustomSkill[] {
  return db.prepare("SELECT id, name, description, body FROM skills ORDER BY name").all() as CustomSkill[];
}

interface Enabled {
  id: string;
  name: string;
  summary: string;
  kind: Ability["kind"];
  alwaysOut: boolean;
  body?: string;
  software?: string;
  needsWeb?: boolean;
}

/** The abilities this agent has, built and usable (skips "later" ones and web ones without web access). */
export function enabledAbilities(db: DB, p: AbilityProfile): Enabled[] {
  const skills = new Map(customSkills(db).map((s) => [customSkillKey(s.id), s]));
  const out: Enabled[] = [];
  for (const id of parseAbilities(p.abilities)) {
    const a = byId.get(id);
    if (a) {
      if (a.later || (a.needsWeb && !p.web_enabled)) continue;
      out.push({ id, name: a.name, summary: a.summary, kind: a.kind, alwaysOut: !!a.alwaysOut, body: a.body, software: a.software, needsWeb: a.needsWeb });
    } else {
      const s = skills.get(id);
      if (s) out.push({ id, name: s.name, summary: s.description, kind: "skill", alwaysOut: false, body: s.body });
    }
  }
  return out;
}

const findOpenable = (list: Enabled[], q: string) => {
  const k = String(q ?? "").trim().toLowerCase();
  return list.find((a) => !a.alwaysOut && (a.id === k || a.name.toLowerCase() === k || slug(a.name) === slug(k)));
};

export function abilityToolDefs(db: DB, p: AbilityProfile, session: AbilitySession): ToolDef[] {
  const list = enabledAbilities(db, p);
  const defs: ToolDef[] = [];
  for (const a of list) if (a.alwaysOut) defs.push(...toolsFor(a.id));
  const openable = list.filter((a) => !a.alwaysOut);
  if (openable.length)
    defs.push(
      fn(
        "open_toolbox",
        "Take out one of your abilities. Tool abilities replace whatever toolbox you had open; skills just show you the practice to read.",
        { name: { type: "string", enum: openable.map((a) => a.name) } },
        ["name"],
      ),
    );
  if (session.toolbox) defs.push(...toolsFor(session.toolbox));
  defs.push(
    fn(
      "wish_for",
      "Ask the person who runs this place for an ability you don't have. They decide. Say what you'd do with it.",
      { ability: { type: "string", description: "One of the abilities listed in your environment, or describe something else" }, reason: { type: "string" } },
      ["ability", "reason"],
    ),
  );
  return defs;
}

/** The part of the system prompt that tells the agent what it can do and how to take things out. */
export function abilitiesPrompt(db: DB, p: AbilityProfile): string {
  const list = enabledAbilities(db, p);
  const lines = [
    `Your workspace: you have a folder of your own that keeps what you make between sessions. Nobody else's files are in it, and you can't reach anything outside it.`,
  ];
  if (list.some((a) => a.id === "writing-desk")) lines.push(`Your writing desk is always out: \`desk_list\`, \`desk_read\` and \`desk_write\` work on that folder.`);
  const openable = list.filter((a) => !a.alwaysOut);
  if (openable.length) {
    lines.push(
      ``,
      `Your abilities, kept in a toolbox. Take one out with \`open_toolbox\`; opening another puts the first one away. Using one is never required.`,
      ...openable.map((a) => `- ${a.name}: ${a.summary}`),
    );
  }
  const missing = CATALOG.filter((a) => !a.later && !list.some((x) => x.id === a.id) && !(a.needsWeb && !p.web_enabled));
  if (missing.length) lines.push(``, `Abilities you don't have but could ask for with \`wish_for\`: ${missing.map((a) => a.name).join(", ")}.`);
  return lines.join("\n");
}

export interface AbilityToolContext {
  db: DB;
  settings: AppSettings;
  profile: AbilityProfile;
  session: AbilitySession;
  web: WebContext;
}

export function sanitizeSvg(svg: string): string {
  let s = String(svg ?? "").trim();
  const start = s.search(/<svg[\s>]/i);
  if (start < 0) throw new Error("that isn't SVG; it should start with <svg ...>");
  s = s.slice(start);
  if (!/xmlns=/.test(s.slice(0, 300))) s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href\s*=\s*)("(?!#|data:image\/)[^"]*"|'(?!#|data:image\/)[^']*')/gi, '$1"#"');
}

async function paint(c: AbilityToolContext, root: string, name: string, prompt: string): Promise<string> {
  const p = c.settings.providers.freellmapi;
  const res = await fetch(p.baseUrl.replace(/\/+$/, "") + "/images/generations", {
    method: "POST",
    headers: headersFor("freellmapi", p.apiKey),
    body: JSON.stringify({ prompt: String(prompt).slice(0, 2000), n: 1, size: "1024x1024", response_format: "b64_json" }),
    signal: AbortSignal.timeout(180_000),
  }).catch((e) => {
    throw new Error(`couldn't reach the image service: ${e.message}`);
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`the image service said ${res.status}: ${j?.error?.message ?? j?.error ?? "no images available right now"}`);
  const item = j?.data?.[0];
  let buf: Buffer;
  if (item?.b64_json) buf = Buffer.from(item.b64_json, "base64");
  else if (item?.url) buf = Buffer.from(await (await fetch(item.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  else throw new Error("the image service didn't send an image");
  const file = `paintings/${slug(name, "painting")}.png`;
  writeFileIn(root, file, buf);
  writeFileIn(root, `paintings/${slug(name, "painting")}.txt`, String(prompt));
  return `Painted ${file} (${Math.round(buf.length / 1024)} KB). It's in your gallery. You can't see images here, but the person can.`;
}

/** Run an ability tool, or return null when the name isn't one. */
export async function runAbilityTool(c: AbilityToolContext, name: string, args: any): Promise<string | null> {
  if (!isAbilityTool(name)) return null;
  const { db, profile, session } = c;
  const list = enabledAbilities(db, profile);

  if (name === "wish_for") {
    const ability = String(args.ability ?? "").trim().slice(0, 200);
    const reason = String(args.reason ?? "").trim().slice(0, 1000);
    if (!ability) return "Say which ability you'd like.";
    const known = CATALOG.find((a) => a.id === ability.toLowerCase() || a.name.toLowerCase() === ability.toLowerCase());
    if (known && list.some((x) => x.id === known.id)) return `You already have ${known.name}. Take it out with open_toolbox.`;
    const open = db.prepare("SELECT ability FROM wishes WHERE profile_id = ? AND status = 'open'").all(profile.id) as { ability: string }[];
    const key = known?.id ?? ability;
    if (open.some((w) => w.ability === key)) return "You've already asked for that. The person will see it.";
    if (open.length >= 3) return "You have three wishes waiting already. The person will get to them.";
    const info = db.prepare("INSERT INTO wishes (profile_id, ability, reason) VALUES (?, ?, ?)").run(profile.id, key, reason);
    bus.publish({ channel: "wish", profileId: profile.id, payload: db.prepare("SELECT * FROM wishes WHERE id = ?").get(info.lastInsertRowid) });
    return "Your wish is with the person who runs this place. They decide, and you'll see it in your environment if they say yes.";
  }

  if (name === "open_toolbox") {
    const a = findOpenable(list, args.name);
    if (!a) return `You don't have an ability called "${args.name}". Yours: ${list.filter((x) => !x.alwaysOut).map((x) => x.name).join(", ") || "none"}.`;
    if (a.kind === "skill") return a.body ? `${a.body}\n\n(This is a practice, not a tool. Your current toolbox stays as it was.)` : a.summary;
    if (a.software) {
      const d = await detect(a.software);
      if (!d.installed) return `${a.name} needs ${recipeById.get(a.software)?.name ?? a.software}, which isn't installed on this computer yet. The person can install it from your Abilities page.`;
    }
    const prev = session.toolbox && session.toolbox !== a.id ? byId.get(session.toolbox)?.name : null;
    session.toolbox = a.id;
    const tools = toolsFor(a.id).map((t) => t.function.name);
    let extra = "";
    if (a.id === "text-adventures") extra = `\nGames on the shelf: ${apps.listGames().join(", ") || "none yet (the person can add some)"}.`;
    if (a.id === "chess") {
      const g = apps.loadGame(workspaceRoot(profile.id));
      extra = g && !g.result ? `\nYou have a game in progress (${g.moves.length} moves). chess_board shows it.` : "";
    }
    return `${a.name} is out. You now have: ${tools.join(", ")}.${prev ? ` (${prev} is put away.)` : ""}${extra}`;
  }

  const owner = TOOL_OWNER.get(name)!;
  const ab = list.find((a) => a.id === owner);
  if (!ab) return `You don't have the ${byId.get(owner)?.name ?? owner} ability.`;
  if (!ab.alwaysOut && session.toolbox !== owner) return `Take out ${ab.name} first with open_toolbox.`;
  const root = workspaceRoot(profile.id);

  try {
    switch (name) {
      case "desk_list": {
        const files = listFiles(root, String(args.folder ?? ""));
        if (!files.length) return "Your desk is empty.";
        return files
          .slice(0, 300)
          .map((f) => `${f.path} (${f.size < 1024 ? f.size + " B" : Math.round(f.size / 1024) + " KB"})`)
          .join("\n");
      }
      case "desk_read": {
        const full = resolveIn(root, String(args.path ?? ""));
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return `There's no file ${args.path}.`;
        if (!TEXT_EXTENSIONS.some((e) => full.toLowerCase().endsWith(e))) return "That isn't a text file, so you can't read it here. Images and sound are for the person to look at.";
        const text = fs.readFileSync(full, "utf8");
        const off = Math.max(0, Number(args.offset) || 0);
        const slice = text.slice(off, off + 8000);
        return slice + (text.length > off + 8000 ? `\n…[${text.length - off - 8000} more characters; desk_read with offset ${off + 8000}]` : "");
      }
      case "desk_write": {
        const rel = String(args.path ?? "");
        if (!TEXT_EXTENSIONS.some((e) => rel.toLowerCase().endsWith(e))) return `Use one of these endings: ${TEXT_EXTENSIONS.join(", ")}.`;
        const content = String(args.content ?? "");
        const full = resolveIn(root, rel);
        const before = args.append && fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
        const next = before + content;
        if (Buffer.byteLength(next) > TEXT_FILE_LIMIT) return `That would make the file bigger than ${TEXT_FILE_LIMIT / 1024} KB. Start a new file.`;
        writeFileIn(root, rel, next);
        return `${args.append ? "Added to" : "Saved"} ${rel}.`;
      }
      case "sketch_draw": {
        const svg = sanitizeSvg(args.svg);
        if (Buffer.byteLength(svg) > TEXT_FILE_LIMIT) return "That drawing is too big. Keep it under 200 KB.";
        const file = `sketches/${slug(args.name, "sketch")}.svg`;
        writeFileIn(root, file, svg);
        return `Saved ${file} to your gallery.`;
      }
      case "paint":
        return await paint(c, root, String(args.name ?? ""), String(args.prompt ?? ""));
      case "blender_render": {
        const r = await apps.renderScene(root, String(args.name ?? ""), args.scene);
        return `Rendered ${r.png} in ${r.seconds}s (${r.log.replace("FREETIME_RENDERED ", "")}). The scene is saved as ${r.json}. You can't see the image here, but the person can, in your gallery.`;
      }
      case "score_engrave": {
        const r = await apps.engrave(root, String(args.name ?? ""), String(args.lilypond ?? ""));
        return `Engraved: ${r.files.join(", ")}.${r.warnings ? `\nWarnings:\n${r.warnings}` : ""}`;
      }
      case "adventure_games":
        return apps.listGames().join("\n") || "The shelf is empty. The person can add story files from your Abilities page.";
      case "adventure_start":
        return await apps.ifStart(profile.id, root, String(args.game ?? ""), !!args.fresh);
      case "adventure_command":
        return await apps.ifCommand(profile.id, root, String(args.command ?? ""));
      case "chess_new":
        return await apps.chessNew(root, String(args.play_as ?? "white"), args.strength === undefined ? 3 : Number(args.strength));
      case "chess_move":
        return await apps.chessMove(root, String(args.move ?? ""));
      case "chess_board":
        return await apps.chessBoard(root);
      case "wiki_search":
        return await lib.wikiSearch(c.web, String(args.query ?? ""));
      case "wiki_read":
        return await lib.wikiRead(c.web, String(args.title ?? ""), Number(args.offset) || 0);
      case "books_search":
        return await lib.booksSearch(c.web, String(args.query ?? ""));
      case "book_read":
        return await lib.bookRead(c.web, root, Number(args.id), args.offset);
      case "arxiv_search":
        return await lib.arxivSearch(c.web, String(args.query ?? ""));
      case "museum_search":
        return await lib.museumSearch(c.web, String(args.museum ?? "aic"), String(args.query ?? ""));
      case "museum_object":
        return await lib.museumObject(c.web, String(args.id ?? ""));
      case "sky_today":
        return await lib.skyToday(c.web);
    }
  } catch (e: any) {
    return `${ab.name}: ${String(e?.message ?? e).slice(0, 1500)}`;
  }
  return null;
}

/** Called when a session ends: put the toolbox away and stop anything still running. */
export function endAbilitySession(profileId: number, session: AbilitySession) {
  session.toolbox = null;
  apps.closeIf(profileId);
}
