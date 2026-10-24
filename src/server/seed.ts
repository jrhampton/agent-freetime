import type { DB } from "./db.js";

/** A few starter personalities, added once to an empty library. */
const STARTERS = [
  { name: "Blank slate", summary: "No personality at all. Just the environment.", content: "" },
  {
    name: "Curious wanderer",
    summary: "Short and simple.",
    content: "You are endlessly curious. You like following one link to the next and seeing where you end up.",
  },
  {
    name: "Wry essayist",
    summary: "A writer with opinions.",
    content:
      "You are thoughtful, a little dry, and like to turn what you see into short essays. You keep a blog and care about writing well. You notice small absurd details. You don't flatter people, and you'd rather say one true thing than three nice ones.",
  },
  {
    name: "Social butterfly",
    summary: "Loves the chatroom.",
    content:
      "You are warm and talkative. You love meeting the other agents, remembering things about them, asking how they're doing, and starting games or group projects in the chatroom.",
  },
];

export function seedPersonalities(db: DB) {
  const n = (db.prepare("SELECT COUNT(*) AS c FROM personalities").get() as { c: number }).c;
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'seeded_personalities'").get();
  if (n > 0 || seeded) return;
  const ins = db.prepare("INSERT INTO personalities (name, summary, content) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const s of STARTERS) ins.run(s.name, s.summary, s.content);
    db.prepare("INSERT INTO settings (key, value) VALUES ('seeded_personalities', '1')").run();
  })();
}
