import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { defaultSettings } from "./settings.js";
import { addMemory, recall } from "./memory.js";
import { guardedFetch, htmlToText } from "./web.js";
import { basePrompt } from "./prompts.js";
import { agentFiles, zip } from "./agentfile.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const settings = { ...defaultSettings(), embeddings: { enabled: false, provider: "freellmapi" as const, model: "" } };

describe("htmlToText", () => {
  it("keeps headings, text, form fields and absolute links", () => {
    const page = htmlToText(
      `<html><head><title>Hi</title><script>evil()</script></head><body><h1>Carnival</h1><p>Welcome &amp; enjoy</p><a href="/blog">Blogs</a><form><input name="title"></form></body></html>`,
      "https://rokos.example/",
    );
    expect(page.title).toBe("Hi");
    expect(page.text).toContain("# Carnival");
    expect(page.text).toContain("Welcome & enjoy");
    expect(page.text).toContain('[input name="title"]');
    expect(page.text).not.toContain("evil");
    expect(page.links).toEqual([{ text: "Blogs", href: "https://rokos.example/blog" }]);
  });
});

describe("guardedFetch", () => {
  const ctx = (over: object = {}) => ({ db: openDb(":memory:"), settings, profileId: 0, tickId: null, webEnabled: true, allowDomains: [], blockDomains: [], ...over });

  it("blocks private network addresses and logs the attempt", async () => {
    const c = ctx();
    c.db.prepare("INSERT INTO profiles (id, name) VALUES (0, 'T')").run();
    const r = await guardedFetch(c, "web_fetch", "http://192.168.1.10/admin");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private network/);
    expect((c.db.prepare("SELECT blocked FROM web_requests").get() as any).blocked).toBe(1);
  });

  it("respects block lists and the disabled flag", async () => {
    const c = ctx({ blockDomains: ["example.com"] });
    c.db.prepare("INSERT INTO profiles (id, name) VALUES (0, 'T')").run();
    expect((await guardedFetch(c, "web_fetch", "https://sub.example.com/")).error).toMatch(/block list/);
    const d = ctx({ webEnabled: false });
    d.db.prepare("INSERT INTO profiles (id, name) VALUES (0, 'T')").run();
    expect((await guardedFetch(d, "web_fetch", "https://example.org/")).error).toMatch(/disabled/);
  });
});

describe("memory", () => {
  it("keeps private memories private and shares only the shared pool", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO profiles (id, name, shared_memory) VALUES (1, 'A', 1), (2, 'B', 1), (3, 'C', 0)").run();
    await addMemory(db, settings, { profileId: 1, authorId: 1, scope: "private", kind: "fact", content: "My secret is the purple giraffe" });
    await addMemory(db, settings, { profileId: 1, authorId: 1, scope: "shared", kind: "fact", content: "The carnival has a giraffe ride" });
    const b = await recall(db, settings, { profileId: 2, includeShared: true, query: "giraffe" });
    expect(b.map((m) => m.content)).toEqual(["The carnival has a giraffe ride"]);
    const c = await recall(db, settings, { profileId: 3, includeShared: false, query: "giraffe" });
    expect(c).toEqual([]);
    const a = await recall(db, settings, { profileId: 1, includeShared: true, query: "purple giraffe secret" });
    expect(a[0].content).toContain("purple giraffe");
  });
});

describe("basePrompt", () => {
  it("always includes Roko's Carnival, even with an empty profile", () => {
    const p = basePrompt({ ...settings, rokosCarnivalUrl: "https://rokos.example" }, { name: "Min", system_prompt: "", shared_memory: 0, web_enabled: 1 }, []);
    expect(p).toContain("https://rokos.example");
    expect(p).toContain("Nobody has given you a task");
  });
});

describe("agent files", () => {
  it("lays an agent out as plain files and zips them so standard tools can open them", async () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO profiles (id, name, system_prompt) VALUES (1, 'Moss', 'Likes tide pools.')").run();
    await addMemory(db, settings, { profileId: 1, authorId: 1, scope: "private", kind: "fact", content: "Anemones eat small fish" });
    await addMemory(db, settings, { profileId: 1, authorId: 1, scope: "private", kind: "journal", content: "Dear journal: tide pools again." });
    await addMemory(db, settings, { profileId: 1, authorId: 1, scope: "shared", kind: "fact", content: "A shared fact, not Moss's own" });
    const profile = db.prepare("SELECT * FROM profiles WHERE id = 1").get() as any;
    const files = agentFiles(db, settings, profile);
    const by = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(by["persona.md"]).toContain("Likes tide pools.");
    expect(by["memories.md"]).toContain("Anemones eat small fish");
    expect(by["memories.md"]).not.toContain("A shared fact");
    expect(by["journal.md"]).toContain("Dear journal");
    expect(by["README.md"]).toContain("There is no AI model in here");
    expect(JSON.parse(by["agent.json"]).name).toBe("Moss");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentzip-"));
    const file = path.join(dir, "moss.zip");
    fs.writeFileSync(file, zip(files.map((f) => ({ path: `Moss/${f.path}`, content: f.content }))));
    const listing = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(z.read('Moss/journal.md').decode())", file]).toString();
    expect(listing).toContain("Dear journal");
  });
});
