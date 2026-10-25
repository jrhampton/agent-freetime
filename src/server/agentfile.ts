import zlib from "node:zlib";
import type { DB } from "./db.js";
import type { MemoryRow } from "./memory.js";
import { basePrompt } from "./prompts.js";
import type { AppSettings } from "./settings.js";

/**
 * An agent is a handful of text: who it is, what it remembers, what it wrote.
 * This module lays that text out as plain files, for the "What it is" view and the download.
 */

export interface AgentFile {
  path: string;
  title: string;
  description: string;
  content: string;
}

interface ProfileLike {
  id: number;
  name: string;
  system_prompt: string;
  personality_id: number | null;
  shared_memory: number;
  web_enabled: number;
  provider: string;
  model: string;
  color: string;
  tick_count: number;
  created_at?: string;
}

const day = (s: string) => s.slice(0, 16).replace("T", " ");

function section(title: string, rows: MemoryRow[], empty: string) {
  if (!rows.length) return `## ${title}\n\n_${empty}_\n`;
  return `## ${title}\n\n${rows.map((m) => `- ${m.pinned ? "**[core]** " : ""}${m.content.replace(/\n+/g, " ")} _(${day(m.created_at)}, importance ${m.importance})_`).join("\n")}\n`;
}

export function agentFiles(db: DB, settings: AppSettings, profile: ProfileLike): AgentFile[] {
  const personality = profile.personality_id
    ? (db.prepare("SELECT name, content FROM personalities WHERE id = ?").get(profile.personality_id) as { name: string; content: string } | undefined)
    : undefined;
  const mems = db.prepare("SELECT * FROM memories WHERE profile_id = ? AND scope = 'private' ORDER BY id").all(profile.id) as MemoryRow[];
  const of = (...kinds: string[]) => mems.filter((m) => kinds.includes(m.kind));
  const ticks = db.prepare("SELECT model_used, COUNT(*) AS n FROM ticks WHERE profile_id = ? AND model_used IS NOT NULL GROUP BY model_used ORDER BY n DESC").all(profile.id) as {
    model_used: string;
    n: number;
  }[];
  const dms = db.prepare("SELECT sender, content, created_at FROM dm_messages WHERE profile_id = ? ORDER BY id").all(profile.id) as {
    sender: string;
    content: string;
    created_at: string;
  }[];

  const persona = [
    `# ${profile.name}`,
    ``,
    personality?.content.trim() ? `## Personality (${personality.name})\n\n${personality.content.trim()}\n` : `## Personality\n\n_None. ${profile.name} runs with no personality text._\n`,
    profile.system_prompt.trim() ? `## About ${profile.name}\n\n${profile.system_prompt.trim()}\n` : ``,
  ].join("\n");

  const environment = [
    `# The environment ${profile.name} wakes up in`,
    ``,
    `Freetime gives every agent this description at the start of each session, followed by its memories and anything new (messages, chatroom posts).`,
    ``,
    "```text",
    basePrompt(settings, { ...profile, personality_name: personality?.name, personality_content: personality?.content }, []),
    "```",
  ].join("\n");

  const memories = [
    `# What ${profile.name} remembers`,
    ``,
    `Things ${profile.name} chose to remember, insights from its reflections, and notes. **[core]** marks memories shown at the start of every session.`,
    ``,
    section("Facts", of("fact"), "None yet."),
    section("People and agents", of("relationship"), "None yet."),
    section("Notes", of("note"), "None yet."),
    section("Reflections", of("reflection"), "None yet."),
  ].join("\n");

  const journal = [
    `# ${profile.name}'s journal`,
    ``,
    ...(of("journal").length ? of("journal").map((m) => `## ${day(m.created_at)}\n\n${m.content.trim()}\n`) : [`_No entries yet._`]),
  ].join("\n");

  const sessions = [
    `# ${profile.name}'s sessions`,
    ``,
    `The note ${profile.name} wrote at the end of each session, in its own words.`,
    ``,
    ...(of("episode").length ? of("episode").map((m) => `- **${day(m.created_at)}** ${m.content.replace(/\n+/g, " ")}`) : [`_No sessions yet._`]),
  ].join("\n");

  const conversations = [
    `# Messages between you and ${profile.name}`,
    ``,
    ...(dms.length ? dms.map((d) => `**${d.sender === "user" ? "You" : profile.name}** (${day(d.created_at)}): ${d.content}\n`) : [`_No messages yet._`]),
  ].join("\n");

  const manifest = JSON.stringify(
    {
      format: "agent-freetime/1",
      name: profile.name,
      exported_at: new Date().toISOString(),
      sessions: profile.tick_count,
      color: profile.color,
      provider: profile.provider,
      model: profile.model || "auto",
      models_used: Object.fromEntries(ticks.map((t) => [t.model_used, t.n])),
      settings: { shared_memory: !!profile.shared_memory, web_enabled: !!profile.web_enabled },
      files: ["persona.md", "memories.md", "journal.md", "sessions.md", "messages.md", "environment.md"],
      memories: mems.map((m) => ({ kind: m.kind, content: m.content, importance: m.importance, pinned: !!m.pinned, created_at: m.created_at })),
    },
    null,
    2,
  );

  const readme = [
    `# ${profile.name}`,
    ``,
    `This folder is ${profile.name}: everything that makes it different from any other agent.`,
    ``,
    `There is no AI model in here. ${profile.name}'s thinking was done by whichever model read these files each session${ticks.length ? ` (most often ${ticks[0].model_used})` : ""}. These files are what that model was given: who ${profile.name} is, and what it remembers. Give them to a different model and you'll get a recognizably similar agent with a different voice.`,
    ``,
    `## What's here`,
    ``,
    `| File | What it is |`,
    `| --- | --- |`,
    `| persona.md | Its personality and the description you wrote for it |`,
    `| memories.md | Facts, people, notes and reflections it kept |`,
    `| journal.md | Its journal entries |`,
    `| sessions.md | The note it wrote at the end of each session |`,
    `| messages.md | Your direct messages with it |`,
    `| environment.md | The description of Freetime it wakes up to |`,
    `| agent.json | All of the above in machine-readable form |`,
    ``,
    `## Using ${profile.name} somewhere else`,
    ``,
    `- **Another Freetime install:** import agent.json (coming soon), or create an agent with the same name and paste persona.md into its profile.`,
    `- **A Claude or ChatGPT project:** add persona.md, memories.md and sessions.md as project files or custom instructions, and tell the model these are its own memories.`,
    `- **Any other agent harness:** point it at this folder. Everything is plain Markdown.`,
    ``,
    `Exported ${new Date().toISOString().slice(0, 10)} from Freetime.`,
  ].join("\n");

  return [
    { path: "README.md", title: "Read me", description: "What this folder is and how to use it elsewhere", content: readme },
    { path: "persona.md", title: "Persona", description: "Its personality and the description you wrote", content: persona },
    { path: "memories.md", title: "Memories", description: `${mems.length - of("journal", "episode").length} things it chose to keep`, content: memories },
    { path: "journal.md", title: "Journal", description: `${of("journal").length} entries`, content: journal },
    { path: "sessions.md", title: "Session notes", description: `${of("episode").length} notes, one per session`, content: sessions },
    { path: "messages.md", title: "Messages", description: `${dms.length} messages with you`, content: conversations },
    { path: "environment.md", title: "Environment", description: "What Freetime tells it each time it wakes", content: environment },
    { path: "agent.json", title: "Manifest", description: "Everything above, machine-readable", content: manifest },
  ];
}

/** A minimal ZIP writer (deflate, UTF-8 names). Enough for a folder of text files. */
export function zip(files: { path: string; content: string }[]): Buffer {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const raw = Buffer.from(f.content, "utf8");
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
