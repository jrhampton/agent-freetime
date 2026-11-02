import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { bus } from "../bus.js";

/**
 * Install recipes for the software abilities.
 *
 * The rule: no model ever types a command here. A recipe is reviewed code with a fixed detect,
 * install and verify step for each OS. The person presses Install in the UI (the guide agent can
 * explain and point at the button, but the button is the approval), and Freetime runs the recipe.
 *
 * Package ids below are the ones published by each package manager as far as we know; each one
 * still needs a real run on Windows, macOS and Linux before release.
 */

export type Platform = "win32" | "darwin" | "linux";
export type Installer = "winget" | "brew" | "flatpak" | "apt";

export interface Recipe {
  id: string;
  name: string;
  about: string;
  homepage: string;
  size: string;
  /** What the agent can reach through it, in plain words. */
  touches: string;
  /** Executable names to look for on PATH. */
  bins: string[];
  /** Common install locations that are not on PATH. Globs allow one `*` per segment. */
  knownPaths?: Partial<Record<Platform, string[]>>;
  versionArgs: string[];
  install: { winget?: string; brew?: { name: string; cask?: boolean }; flatpak?: string; apt?: string };
  /** Shown when there's no installer we can drive. */
  manualUrl: string;
}

export const RECIPES: Recipe[] = [
  {
    id: "blender",
    name: "Blender",
    about: "Free, open-source 3D creation suite from the Blender Foundation.",
    homepage: "https://www.blender.org/download/",
    size: "about 350 MB",
    touches:
      "Freetime runs Blender in the background with a fixed script that only builds the shapes, lights and camera the agent describes, and saves the render to the agent's workspace. The agent never writes Blender's Python itself.",
    bins: ["blender"],
    knownPaths: {
      win32: ["C:\\Program Files\\Blender Foundation\\Blender*\\blender.exe"],
      darwin: ["/Applications/Blender.app/Contents/MacOS/Blender"],
      linux: ["/snap/bin/blender", "/opt/blender*/blender"],
    },
    versionArgs: ["--version"],
    install: { winget: "BlenderFoundation.Blender", brew: { name: "blender", cask: true }, flatpak: "org.blender.Blender", apt: "blender" },
    manualUrl: "https://www.blender.org/download/",
  },
  {
    id: "lilypond",
    name: "LilyPond",
    about: "Music engraving program: turns music written as text into sheet music and MIDI.",
    homepage: "https://lilypond.org/download.html",
    size: "about 100 MB",
    touches: "Runs in LilyPond's safe mode, which blocks the file and system commands its language could otherwise use. Output goes to the agent's workspace.",
    bins: ["lilypond"],
    knownPaths: { win32: ["C:\\Program Files*\\LilyPond*\\bin\\lilypond.exe", "C:\\lilypond*\\bin\\lilypond.exe"] },
    versionArgs: ["--version"],
    install: { winget: "LilyPond.LilyPond", brew: { name: "lilypond" }, apt: "lilypond" },
    manualUrl: "https://lilypond.org/download.html",
  },
  {
    id: "stockfish",
    name: "Stockfish",
    about: "Free, open-source chess engine.",
    homepage: "https://stockfishchess.org/download/",
    size: "about 50 MB",
    touches: "A chess engine only. It reads moves and prints moves; it can't touch files or the network.",
    bins: ["stockfish"],
    knownPaths: { linux: ["/usr/games/stockfish"] },
    versionArgs: [],
    install: { winget: "Stockfish.Stockfish", brew: { name: "stockfish" }, apt: "stockfish" },
    manualUrl: "https://stockfishchess.org/download/",
  },
  {
    id: "frotz",
    name: "Frotz (dfrotz)",
    about: "Interpreter for Infocom-style interactive fiction (Z-machine story files).",
    homepage: "https://gitlab.com/DavidGriffith/frotz",
    size: "under 1 MB",
    touches: "Plays story files from Freetime's games shelf. Saving and restoring are turned off; Freetime keeps the agent's progress itself.",
    bins: ["dfrotz"],
    knownPaths: { linux: ["/usr/games/dfrotz"] },
    versionArgs: ["-v"],
    // Windows has no packaged dfrotz; people there get the manual link.
    install: { brew: { name: "frotz" }, apt: "frotz" },
    manualUrl: "https://gitlab.com/DavidGriffith/frotz",
  },
];

export const recipeById = new Map(RECIPES.map((r) => [r.id, r]));

// ---------------------------------------------------------------- environment

export const inDocker = () => fs.existsSync("/.dockerenv") || process.env.FREETIME_DOCKER === "1";

function onPath(bin: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (process.platform !== "win32") dirs.push("/usr/games", "/usr/local/bin", "/opt/homebrew/bin");
  for (const d of dirs)
    for (const e of exts) {
      const p = path.join(d, bin + e.toLowerCase());
      const P = path.join(d, bin + e);
      for (const c of [p, P]) {
        try {
          if (fs.statSync(c).isFile()) return c;
        } catch {}
      }
    }
  return null;
}

/** Expand a path with `*` wildcards in its segments (one level of matching per segment). */
export function expandGlob(pattern: string): string[] {
  const sep = pattern.includes("\\") ? "\\" : "/";
  const parts = pattern.split(sep);
  let bases = [parts[0] === "" ? sep : parts[0] + (parts[0].endsWith(":") ? sep : "")];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const next: string[] = [];
    for (const b of bases) {
      if (!part.includes("*")) {
        next.push(path.join(b, part));
        continue;
      }
      const re = new RegExp("^" + part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
      try {
        for (const n of fs.readdirSync(b)) if (re.test(n)) next.push(path.join(b, n));
      } catch {}
    }
    bases = next;
  }
  return bases.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

export interface Detected {
  installed: boolean;
  /** Command prefix to run it, e.g. ["/usr/bin/blender"] or ["flatpak", "run", "org.blender.Blender"]. */
  command?: string[];
  version?: string;
}

const detected = new Map<string, Detected>();

async function versionOf(command: string[], args: string[], id: string): Promise<string> {
  if (id === "stockfish") {
    const r = await uciProbe(command);
    return r ?? "";
  }
  const r = await run(command[0], [...command.slice(1), ...args]);
  return (r.out.split("\n").find((l) => /\d+\.\d+/.test(l)) ?? r.out.split("\n")[0] ?? "").trim().slice(0, 80);
}

/** Stockfish has no --version; it prints its name on start and answers "uci". */
function uciProbe(command: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(command[0], command.slice(1), { windowsHide: true });
    let out = "";
    const done = (v: string | null) => {
      clearTimeout(t);
      p.kill();
      resolve(v);
    };
    const t = setTimeout(() => done(null), 8000);
    p.on("error", () => done(null));
    p.stdout.on("data", (d) => {
      out += d;
      if (out.includes("uciok")) done((out.match(/id name (.+)/)?.[1] ?? "Stockfish").trim());
    });
    p.stdin.write("uci\n");
  });
}

export async function detect(id: string, refresh = false): Promise<Detected> {
  const r = recipeById.get(id);
  if (!r) return { installed: false };
  if (!refresh && detected.has(id)) return detected.get(id)!;
  let command: string[] | undefined;
  for (const b of r.bins) {
    const p = onPath(b);
    if (p) {
      command = [p];
      break;
    }
  }
  if (!command) {
    const plat = process.platform as Platform;
    for (const pat of r.knownPaths?.[plat] ?? []) {
      const hit = expandGlob(pat).sort().pop();
      if (hit) {
        command = [hit];
        break;
      }
    }
  }
  if (!command && r.install.flatpak && onPath("flatpak")) {
    const f = await run("flatpak", ["info", r.install.flatpak]);
    if (f.code === 0) command = ["flatpak", "run", r.install.flatpak];
  }
  const result: Detected = command ? { installed: true, command, version: await versionOf(command, r.versionArgs, id) } : { installed: false };
  detected.set(id, result);
  return result;
}

/** The command for an installed program, or a message for the agent if it isn't there. */
export async function commandFor(id: string): Promise<string[]> {
  const d = await detect(id);
  if (!d.installed || !d.command) throw new Error(`${recipeById.get(id)?.name ?? id} isn't installed on this computer. You can ask the person for it with wish_for.`);
  return d.command;
}

// ---------------------------------------------------------------- install planning

export interface InstallPlan {
  ok: boolean;
  installer?: Installer;
  /** Exactly what will run, shown to the person before they press Install. */
  command?: string[];
  /** Why we can't install it from here, and what to do instead. */
  reason?: string;
  manualUrl: string;
}

export interface InstallEnv {
  platform: string;
  docker: boolean;
  root: boolean;
  has: Partial<Record<Installer | "pkexec", boolean>>;
}

export function installEnv(): InstallEnv {
  return {
    platform: process.platform,
    docker: inDocker(),
    root: typeof process.getuid === "function" && process.getuid() === 0,
    has: {
      winget: process.platform === "win32" && !!onPath("winget"),
      brew: process.platform === "darwin" && !!onPath("brew"),
      flatpak: process.platform === "linux" && !!onPath("flatpak"),
      apt: process.platform === "linux" && !!onPath("apt-get"),
      pkexec: process.platform === "linux" && !!onPath("pkexec"),
    },
  };
}

/** Pure: decide how to install a recipe in a given environment. Tested without touching the system. */
export function planInstall(r: Recipe, env: InstallEnv): InstallPlan {
  const manualUrl = r.manualUrl;
  if (env.docker)
    return {
      ok: false,
      manualUrl,
      reason: `Freetime is running in Docker, so it can't install programs on your computer. Rebuild the image with FREETIME_APPS="${r.install.apt ?? r.id}" (see the README), or use the native install.`,
    };
  const i = r.install;
  if (env.platform === "win32") {
    if (i.winget && env.has.winget)
      return { ok: true, manualUrl, installer: "winget", command: ["winget", "install", "--id", i.winget, "--exact", "--accept-source-agreements", "--accept-package-agreements"] };
    return { ok: false, manualUrl, reason: i.winget ? "winget isn't available on this PC." : `There's no winget package for ${r.name}.` };
  }
  if (env.platform === "darwin") {
    if (i.brew && env.has.brew) return { ok: true, manualUrl, installer: "brew", command: ["brew", "install", ...(i.brew.cask ? ["--cask"] : []), i.brew.name] };
    return { ok: false, manualUrl, reason: "Homebrew isn't installed. Download it from the official page instead, then press Check again." };
  }
  if (env.platform === "linux") {
    if (i.flatpak && env.has.flatpak) return { ok: true, manualUrl, installer: "flatpak", command: ["flatpak", "install", "--user", "-y", "flathub", i.flatpak] };
    if (i.apt && env.has.apt) {
      const apt = ["apt-get", "install", "-y", "--no-install-recommends", i.apt];
      if (env.root) return { ok: true, manualUrl, installer: "apt", command: apt };
      if (env.has.pkexec) return { ok: true, manualUrl, installer: "apt", command: ["pkexec", ...apt] };
      return { ok: false, manualUrl, reason: `Installing needs administrator rights. Run this yourself, then press Check again: sudo ${apt.join(" ")}` };
    }
  }
  return { ok: false, manualUrl, reason: `No supported package manager found for ${r.name} here.` };
}

// ---------------------------------------------------------------- install jobs

export interface InstallJob {
  recipe: string;
  state: "running" | "verifying" | "done" | "failed";
  command: string[];
  log: string;
  startedAt: number;
  result?: Detected;
  error?: string;
}

const jobs = new Map<string, InstallJob>();
export const jobFor = (id: string) => jobs.get(id);

function publishJob(job: InstallJob) {
  bus.publish({ channel: "install", payload: { ...job, log: job.log.slice(-6000) } });
}

/** Run the planned install for a recipe. Only called from the operator's Install button. */
export function startInstall(id: string, verify: (d: Detected) => Promise<string>): InstallJob {
  const r = recipeById.get(id);
  if (!r) throw new Error("unknown software");
  const running = jobs.get(id);
  if (running && (running.state === "running" || running.state === "verifying")) return running;
  const plan = planInstall(r, installEnv());
  if (!plan.ok || !plan.command) throw new Error(plan.reason ?? "can't install here");
  const job: InstallJob = { recipe: id, state: "running", command: plan.command, log: `$ ${plan.command.join(" ")}\n`, startedAt: Date.now() };
  jobs.set(id, job);
  publishJob(job);
  const child = spawn(plan.command[0], plan.command.slice(1), {
    windowsHide: false,
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive", HOMEBREW_NO_AUTO_UPDATE: "1" },
  });
  let last = 0;
  const append = (d: Buffer) => {
    job.log = (job.log + d.toString()).slice(-50_000);
    if (Date.now() - last > 400) {
      last = Date.now();
      publishJob(job);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timer = setTimeout(() => child.kill(), 30 * 60_000);
  child.on("error", (e) => {
    clearTimeout(timer);
    job.state = "failed";
    job.error = e.message;
    publishJob(job);
  });
  child.on("close", async (code) => {
    clearTimeout(timer);
    if (job.state === "failed") return;
    if (code !== 0) {
      job.state = "failed";
      job.error = `The installer exited with code ${code}.`;
      publishJob(job);
      return;
    }
    job.state = "verifying";
    publishJob(job);
    const d = await detect(id, true);
    if (!d.installed) {
      job.state = "failed";
      job.error = "The installer finished, but Freetime still can't find the program. It may need a restart of Freetime, or a custom install location.";
      publishJob(job);
      return;
    }
    try {
      job.log += `\n${await verify(d)}\n`;
      job.state = "done";
      job.result = d;
    } catch (e: any) {
      job.state = "failed";
      job.error = `Installed, but the test run failed: ${e?.message ?? e}`;
    }
    publishJob(job);
  });
  return job;
}

export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "freetime-"));
