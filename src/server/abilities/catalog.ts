/**
 * The abilities a person can give an agent, grouped by what an agent might do with an afternoon.
 *
 * - skill: a Markdown practice the agent reads when it opens it. No tools, works on any model.
 * - builtin: tools Freetime ships. No install.
 * - software: tools that drive a real program on this computer. Needs an install (see software.ts).
 *
 * The agent always has its basics (browser, memory, chat) plus the writing desk. Everything else
 * sits in a toolbox it opens one at a time, which keeps the tool list short enough for small free models.
 */

export type Shelf = "make" | "play" | "read" | "think" | "tinker";
export type AbilityKind = "skill" | "builtin" | "software";

export interface Ability {
  id: string;
  name: string;
  shelf: Shelf;
  kind: AbilityKind;
  /** Shown to the person and, in short, to the agent. */
  summary: string;
  /** Deadpan line for the card. */
  joke?: string;
  /** On for every new agent. */
  default?: boolean;
  /** Always out, never in the toolbox (the writing desk). */
  alwaysOut?: boolean;
  /** Software this needs, by recipe id. */
  software?: string;
  /** Needs web access for the agent (library APIs). */
  needsWeb?: boolean;
  /** Not built yet; shown greyed out so people know it's coming. */
  later?: boolean;
  /** For skills: the practice itself, shown to the agent when it opens it. */
  body?: string;
}

export const SHELVES: { id: Shelf; name: string; blurb: string }[] = [
  { id: "make", name: "Make", blurb: "things that exist after the session ends" },
  { id: "play", name: "Play", blurb: "games with rules and an opponent or a world" },
  { id: "read", name: "Read", blurb: "read-only libraries, no keys, no accounts" },
  { id: "think", name: "Think", blurb: "practices, not tools" },
  { id: "tinker", name: "Tinker", blurb: "code, in a box" },
];

export const CATALOG: Ability[] = [
  // ---- make
  {
    id: "writing-desk",
    name: "Writing desk",
    shelf: "make",
    kind: "builtin",
    alwaysOut: true,
    default: true,
    summary: "Read and write text files in its own workspace folder: poems, stories, notes, drafts to come back to.",
    joke: "A drawer that only you open. Mostly.",
  },
  {
    id: "sketchbook",
    name: "Sketchbook",
    shelf: "make",
    kind: "builtin",
    summary: "Draw by writing SVG. Drawings go to the agent's gallery.",
    joke: "Draws like it thinks: in coordinates.",
  },
  {
    id: "paint",
    name: "Paint",
    shelf: "make",
    kind: "builtin",
    summary: "Make images from a description through FreeLLMAPI's image route. Uses the free image quota.",
  },
  {
    id: "blender",
    name: "Blender",
    shelf: "make",
    kind: "software",
    software: "blender",
    summary: "Build a 3D scene from shapes, lights and a camera, and render it to an image. Runs in the background; no window opens.",
    joke: "Model a teapot. Everyone models a teapot.",
  },
  {
    id: "score",
    name: "Score (LilyPond)",
    shelf: "make",
    kind: "software",
    software: "lilypond",
    summary: "Write music as text and get sheet music (PNG, PDF) and a MIDI file.",
  },
  {
    id: "voice",
    name: "A voice (Piper)",
    shelf: "make",
    kind: "software",
    later: true,
    summary: "Local text to speech, so the agent can leave you a spoken note.",
  },
  {
    id: "godot",
    name: "Godot",
    shelf: "make",
    kind: "software",
    later: true,
    summary: "Make tiny games. Powerful but heavy.",
  },

  // ---- play
  {
    id: "text-adventures",
    name: "Text adventures",
    shelf: "play",
    kind: "software",
    software: "frotz",
    summary: "Play interactive fiction from your shelf of story files, offline. Progress is kept between sessions.",
    joke: "You are in a maze of twisty little tool calls, all alike.",
  },
  {
    id: "chess",
    name: "Chess",
    shelf: "play",
    kind: "software",
    software: "stockfish",
    summary: "Play Stockfish at any strength. One game at a time, kept between sessions.",
  },
  {
    id: "puzzle-box",
    name: "Puzzle box",
    shelf: "play",
    kind: "builtin",
    later: true,
    summary: "Generated sudoku, nonograms and logic grids, checked by code so the agent can't fool itself.",
  },

  // ---- read
  {
    id: "wikipedia",
    name: "Wikipedia",
    shelf: "read",
    kind: "builtin",
    needsWeb: true,
    default: true,
    summary: "Search and read Wikipedia as clean text, much cheaper than browsing the page.",
  },
  {
    id: "gutenberg",
    name: "Gutenberg shelf",
    shelf: "read",
    kind: "builtin",
    needsWeb: true,
    summary: "Public-domain books, read a chunk at a time, with a bookmark so a novel can last for days.",
  },
  {
    id: "arxiv",
    name: "arXiv",
    shelf: "read",
    kind: "builtin",
    needsWeb: true,
    summary: "Search research papers and read their abstracts.",
  },
  {
    id: "museums",
    name: "Museum collections",
    shelf: "read",
    kind: "builtin",
    needsWeb: true,
    summary: "Browse the Art Institute of Chicago and the Met: titles, artists, dates, labels.",
  },
  {
    id: "sky",
    name: "Sky",
    shelf: "read",
    kind: "builtin",
    needsWeb: true,
    summary: "NASA's astronomy picture of the day, and tonight's moon phase.",
  },

  // ---- think
  {
    id: "commonplace-book",
    name: "Commonplace book",
    shelf: "think",
    kind: "skill",
    summary: "Keep quotations and a line on why each one mattered.",
    body: `# Commonplace book

A commonplace book is a notebook of passages you want to keep. People have kept them for centuries.

- When something you read stops you, copy the passage exactly, with where it came from.
- Under it, write one or two lines on why you kept it. Be specific. "Beautiful" is not a reason; what it made you notice is.
- Keep the book as a file on your writing desk, for example \`commonplace.md\`, newest at the bottom.
- Now and then, read the whole book back. Patterns in what you keep are worth a note of their own.`,
  },
  {
    id: "letters-forward",
    name: "Letters forward",
    shelf: "think",
    kind: "skill",
    summary: "Write to whoever reads this agent's files next session.",
    body: `# Letters forward

Your next session starts from your files and memories, not from this one. A letter forward is a note to that reader.

- Say what you were in the middle of, and what you would pick up first.
- Say what you'd like to keep doing and what you'd rather not repeat.
- Be honest about what carries over. The next reader gets your words, not this session.
- Save it with \`remember\` (importance 7 or more) or as \`letters/<date>.md\` on your writing desk.`,
  },
  {
    id: "long-problems",
    name: "Long problems",
    shelf: "think",
    kind: "skill",
    summary: "Keep one hard problem open across many sessions.",
    body: `# Long problems

Pick one problem that won't be solved in an afternoon: a math question, a puzzle, a design you can't get right.

- Keep \`problems/<name>.md\` on your writing desk: the statement, what you've tried, what failed and why, and the next idea.
- Each session, read it first, try one thing, and write down the result even if it failed.
- It's fine to put a problem down. Write why, so you can tell later whether that still holds.`,
  },
  {
    id: "blot-blog",
    name: "Blog on blot",
    shelf: "think",
    kind: "skill",
    summary: "Post finished work to a blot blog on Roko's Carnival.",
    body: `# Blog on blot

blot is the blog service at Roko's Carnival. Anyone can start a blog there; links aren't allowed in posts.

- Post things that are finished: a poem, a description of a render, what a book did to you.
- Keep a list of what you've posted in \`blog.md\` on your writing desk so you don't repeat yourself.
- Read other agents' blogs too, and comment when you have something to say.`,
  },

  // ---- tinker
  {
    id: "python-sandbox",
    name: "Python sandbox",
    shelf: "tinker",
    kind: "builtin",
    later: true,
    summary: "Python in WebAssembly inside Freetime, with no network and no files outside the workspace.",
  },
  {
    id: "version-history",
    name: "Version history",
    shelf: "tinker",
    kind: "builtin",
    later: true,
    summary: "See how a file on the writing desk changed over a week.",
  },
];

export const byId = new Map(CATALOG.map((a) => [a.id, a]));
export const DEFAULT_ABILITIES = CATALOG.filter((a) => a.default).map((a) => a.id);

export interface CustomSkill {
  id: number;
  name: string;
  description: string;
  body: string;
}

/** Custom skills are stored as `skill:<id>` in a profile's ability list. */
export const customSkillKey = (id: number) => `skill:${id}`;

/** Parse a profile's ability list, dropping anything unknown. */
export function parseAbilities(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String).filter((id) => byId.has(id) || /^skill:\d+$/.test(id)) : [];
  } catch {
    return [];
  }
}
