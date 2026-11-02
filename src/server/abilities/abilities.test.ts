import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { defaultSettings } from "../settings.js";
import { parseAbilities, DEFAULT_ABILITIES } from "./catalog.js";
import { resolveIn, slug } from "./workspace.js";
import { planInstall, recipeById, detect, type InstallEnv } from "./software.js";
import { checkLilypond, chessMove, chessNew, renderScene } from "./apps.js";
import { moonPhase } from "./library.js";
import { abilitiesPrompt, abilityToolDefs, runAbilityTool, sanitizeSvg, type AbilitySession } from "./index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ft-test-"));

describe("workspace paths", () => {
  it("keeps agents inside their own folder", () => {
    const root = tmp();
    expect(resolveIn(root, "poems/one.md")).toBe(path.join(root, "poems/one.md"));
    expect(resolveIn(root, "/poems/one.md")).toBe(path.join(root, "poems/one.md"));
    expect(() => resolveIn(root, "../escape.md")).toThrow();
    expect(() => resolveIn(root, "a/../../escape.md")).toThrow();
    fs.symlinkSync(os.tmpdir(), path.join(root, "link"));
    expect(() => resolveIn(root, "link/x.md")).toThrow(/outside/);
  });

  it("makes safe file names", () => {
    expect(slug("My Tea-pot!.png")).toBe("my-tea-pot");
    expect(slug("../../etc/passwd")).toBe("etc-passwd");
    expect(slug("")).toBe("untitled");
  });
});

describe("install plans", () => {
  const env = (over: Partial<InstallEnv>): InstallEnv => ({ platform: "linux", docker: false, root: false, has: {}, ...over });
  const blender = recipeById.get("blender")!;

  it("never installs from inside Docker", () => {
    const p = planInstall(blender, env({ docker: true, root: true, has: { apt: true } }));
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/FREETIME_APPS/);
  });
  it("uses winget on Windows", () => {
    expect(planInstall(blender, env({ platform: "win32", has: { winget: true } })).command).toEqual([
      "winget",
      "install",
      "--id",
      "BlenderFoundation.Blender",
      "--exact",
      "--accept-source-agreements",
      "--accept-package-agreements",
    ]);
  });
  it("points Macs without Homebrew at the download page", () => {
    const p = planInstall(blender, env({ platform: "darwin" }));
    expect(p.ok).toBe(false);
    expect(p.manualUrl).toContain("blender.org");
  });
  it("prefers a user flatpak on Linux, then apt with a password prompt, then tells you the command", () => {
    expect(planInstall(blender, env({ has: { flatpak: true, apt: true } })).installer).toBe("flatpak");
    expect(planInstall(blender, env({ has: { apt: true, pkexec: true } })).command?.[0]).toBe("pkexec");
    const manual = planInstall(blender, env({ has: { apt: true } }));
    expect(manual.ok).toBe(false);
    expect(manual.reason).toContain("sudo apt-get install");
  });
  it("has no Windows package for dfrotz", () => {
    expect(planInstall(recipeById.get("frotz")!, env({ platform: "win32", has: { winget: true } })).ok).toBe(false);
  });
});

describe("LilyPond guard", () => {
  it("allows plain values and blocks Scheme code and file access", () => {
    expect(checkLilypond(`\\relative c' { \\override NoteHead.color = #red c4 d e f | g1 } \\header { title = "A #(tune)" } % #(not code)`)).toBeNull();
    expect(checkLilypond(`\\paper { #(set-paper-size "a4") }`)).toMatch(/Scheme/);
    expect(checkLilypond(`# (system "rm -rf ~")`)).toMatch(/Scheme/);
    expect(checkLilypond(`$(system "x")`)).toMatch(/\$/);
    expect(checkLilypond(`\\include "/etc/passwd"`)).toMatch(/include/);
    expect(checkLilypond(`\\markup \\verbatim-file "/etc/passwd"`)).toMatch(/other files/);
    // A quote inside a comment must not hide code on later lines.
    expect(checkLilypond(`% "\n#(system "x")\n% "`)).toMatch(/Scheme/);
    expect(checkLilypond(`"a % b" #(system "x")`)).toMatch(/Scheme/);
  });
});

describe("SVG sketches", () => {
  it("strips scripts, handlers and external links", () => {
    const s = sanitizeSvg(`<svg viewBox="0 0 10 10"><script>alert(1)</script><circle onload="x()" r="4"/><a href="https://evil"><text>hi</text></a><use href="#c"/></svg>`);
    expect(s).not.toMatch(/script|onload|evil/);
    expect(s).toContain('href="#c"');
    expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(() => sanitizeSvg("hello")).toThrow();
  });
});

describe("toolbox", () => {
  const settings = { ...defaultSettings(), embeddings: { enabled: false, provider: "freellmapi" as const, model: "" } };
  const setup = (abilities: string[]) => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO profiles (id, name, abilities) VALUES (1, 'Ada', ?)").run(JSON.stringify(abilities));
    const profile = { id: 1, name: "Ada", abilities: JSON.stringify(abilities), web_enabled: 1 };
    const session: AbilitySession = { toolbox: null };
    const web = { db, settings, profileId: 1, tickId: null, webEnabled: true, allowDomains: [], blockDomains: [] };
    return { db, profile, session, ctx: { db, settings, profile, session, web } };
  };
  const names = (defs: { function: { name: string } }[]) => defs.map((d) => d.function.name);

  it("drops unknown abilities and has sensible defaults", () => {
    expect(parseAbilities('["wikipedia","nope","skill:3"]')).toEqual(["wikipedia", "skill:3"]);
    expect(DEFAULT_ABILITIES).toEqual(["writing-desk", "wikipedia"]);
  });

  it("keeps the desk out and everything else in the toolbox until opened", async () => {
    const { db, profile, session, ctx } = setup(["writing-desk", "wikipedia", "commonplace-book"]);
    expect(names(abilityToolDefs(db, profile, session))).toEqual(["desk_list", "desk_read", "desk_write", "open_toolbox", "wish_for"]);
    expect(await runAbilityTool(ctx, "wiki_search", { query: "x" })).toMatch(/open_toolbox/);
    expect(await runAbilityTool(ctx, "open_toolbox", { name: "Wikipedia" })).toMatch(/wiki_search/);
    expect(names(abilityToolDefs(db, profile, session))).toContain("wiki_read");
    // A skill shows its practice and leaves the open toolbox alone.
    expect(await runAbilityTool(ctx, "open_toolbox", { name: "Commonplace book" })).toMatch(/# Commonplace book/);
    expect(session.toolbox).toBe("wikipedia");
    expect(await runAbilityTool(ctx, "open_toolbox", { name: "Chess" })).toMatch(/don't have/);
    expect(abilitiesPrompt(db, profile)).toContain("Commonplace book");
  });

  it("writes and reads on the desk", async () => {
    const { ctx } = setup(["writing-desk"]);
    expect(await runAbilityTool(ctx, "desk_write", { path: "poems/rain.md", content: "rain\n" })).toMatch(/Saved/);
    expect(await runAbilityTool(ctx, "desk_write", { path: "poems/rain.md", content: "more", append: true })).toMatch(/Added/);
    expect(await runAbilityTool(ctx, "desk_read", { path: "poems/rain.md" })).toBe("rain\nmore");
    expect(await runAbilityTool(ctx, "desk_write", { path: "x.exe", content: "MZ" })).toMatch(/endings/);
    expect(await runAbilityTool(ctx, "desk_read", { path: "../../harness.db" })).toMatch(/\.\./);
  });

  it("files wishes for the person, with a limit", async () => {
    const { db, ctx } = setup(["writing-desk"]);
    expect(await runAbilityTool(ctx, "wish_for", { ability: "Chess", reason: "I'd like an opponent" })).toMatch(/with the person/);
    expect(await runAbilityTool(ctx, "wish_for", { ability: "chess", reason: "again" })).toMatch(/already asked/);
    await runAbilityTool(ctx, "wish_for", { ability: "Blender", reason: "" });
    await runAbilityTool(ctx, "wish_for", { ability: "a telescope", reason: "" });
    expect(await runAbilityTool(ctx, "wish_for", { ability: "Paint", reason: "" })).toMatch(/three/);
    expect((db.prepare("SELECT ability FROM wishes ORDER BY id").all() as any[]).map((w) => w.ability)).toEqual(["chess", "blender", "a telescope"]);
  });
});

describe("moon phase", () => {
  it("knows a full moon from a new one", () => {
    expect(moonPhase(new Date(Date.UTC(2024, 0, 25, 18))).illumination).toBeGreaterThan(95);
    expect(moonPhase(new Date(Date.UTC(2024, 1, 9, 23))).illumination).toBeLessThan(5);
  });
});

// These run only where the programs are installed.
const has = async (id: string) => (await detect(id)).installed;

describe("software, when installed", async () => {
  it.skipIf(!(await has("stockfish")))("plays chess and rejects illegal moves", async () => {
    const root = tmp();
    expect(await chessNew(root, "white", 0)).toContain("Legal moves:");
    expect(await chessMove(root, "e9e9")).toMatch(/isn't a legal move/);
    expect(await chessMove(root, "e2e4")).toMatch(/Stockfish answered/);
  });
  it.skipIf(!(await has("blender")))(
    "renders a described scene without running agent code",
    async () => {
      const root = tmp();
      const r = await renderScene(root, "Cube", { objects: [{ shape: "cube", color: "#e5322d" }], samples: 4, resolution: [64, 48] });
      expect(fs.existsSync(path.join(root, r.png))).toBe(true);
    },
    120_000,
  );
});
