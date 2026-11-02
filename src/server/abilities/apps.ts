import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "../config.js";
import { commandFor } from "./software.js";
import { resolveIn, slug, writeFileIn } from "./workspace.js";

/** Run a program to completion with a timeout. Never through a shell. */
function runProgram(cmd: string[], opts: { cwd?: string; timeoutMs: number; input?: string }): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, windowsHide: true });
    let out = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, opts.timeoutMs);
    p.stdout.on("data", (d) => (out = (out + d).slice(-40_000)));
    p.stderr.on("data", (d) => (out = (out + d).slice(-40_000)));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: String(e.message), timedOut });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, timedOut });
    });
    if (opts.input !== undefined) p.stdin.end(opts.input);
  });
}

// ================================================================ Blender

/**
 * The agent describes a scene as data; this fixed script builds and renders it. The agent never
 * writes Blender Python, because Blender's Python can do anything the user can.
 */
export const BLENDER_SCRIPT = String.raw`
import bpy, json, math, sys
from mathutils import Vector
argv = sys.argv[sys.argv.index("--") + 1:]
scene_path, out_path = argv[0], argv[1]
with open(scene_path) as f:
    S = json.load(f)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

def hexcol(h, a=1.0):
    h = (h or "#cccccc").lstrip("#")
    if len(h) == 3: h = "".join(c * 2 for c in h)
    try: r, g, b = (int(h[i:i+2], 16) / 255 for i in (0, 2, 4))
    except Exception: r, g, b = 0.8, 0.8, 0.8
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), a)

def vec(v, d):
    if isinstance(v, (int, float)): return (v, v, v)
    if isinstance(v, list) and len(v) == 3: return tuple(float(x) for x in v)
    return d

shapes = {
    "cube": lambda: bpy.ops.mesh.primitive_cube_add(size=1),
    "sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, segments=48, ring_count=24),
    "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1, vertices=48),
    "cone": lambda: bpy.ops.mesh.primitive_cone_add(radius1=0.5, depth=1, vertices=48),
    "torus": lambda: bpy.ops.mesh.primitive_torus_add(major_radius=0.5, minor_radius=0.15),
    "plane": lambda: bpy.ops.mesh.primitive_plane_add(size=1),
    "monkey": lambda: bpy.ops.mesh.primitive_monkey_add(size=1),
    "ico": lambda: bpy.ops.mesh.primitive_ico_sphere_add(radius=0.5, subdivisions=1),
}

count = 0
for o in S.get("objects", [])[:200]:
    kind = o.get("shape", "cube")
    if kind == "text":
        bpy.ops.object.text_add()
        obj = bpy.context.active_object
        obj.data.body = str(o.get("text", ""))[:200]
        obj.data.extrude = float(o.get("depth", 0.05))
        obj.data.align_x = "CENTER"
    elif kind in shapes:
        shapes[kind]()
        obj = bpy.context.active_object
        if o.get("smooth", kind in ("sphere", "monkey", "torus", "cylinder", "cone")):
            bpy.ops.object.shade_smooth()
    else:
        continue
    obj.location = vec(o.get("location"), (0, 0, 0))
    obj.rotation_euler = tuple(math.radians(a) for a in vec(o.get("rotation"), (0, 0, 0)))
    obj.scale = vec(o.get("scale"), (1, 1, 1))
    mat = bpy.data.materials.new("m%d" % count)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    col = hexcol(o.get("color"))
    bsdf.inputs["Base Color"].default_value = col
    bsdf.inputs["Metallic"].default_value = max(0.0, min(1.0, float(o.get("metallic", 0))))
    bsdf.inputs["Roughness"].default_value = max(0.0, min(1.0, float(o.get("roughness", 0.5))))
    em = float(o.get("emission", 0))
    if em > 0:
        key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[key].default_value = col
        bsdf.inputs["Emission Strength"].default_value = min(em, 50.0)
    t = float(o.get("transparency", 0))
    if t > 0:
        key = "Transmission Weight" if "Transmission Weight" in bsdf.inputs else "Transmission"
        bsdf.inputs[key].default_value = max(0.0, min(1.0, t))
    obj.data.materials.append(mat)
    count += 1

lights = S.get("lights") or [{"type": "sun", "rotation": [50, 0, 30], "energy": 3}]
for i, l in enumerate(lights[:20]):
    kind = l.get("type", "point").upper()
    if kind not in ("POINT", "SUN", "AREA", "SPOT"): kind = "POINT"
    data = bpy.data.lights.new("l%d" % i, kind)
    data.energy = float(l.get("energy", 3 if kind == "SUN" else 500))
    data.color = hexcol(l.get("color", "#ffffff"))[:3]
    if kind == "AREA": data.size = float(l.get("size", 2))
    ob = bpy.data.objects.new("l%d" % i, data)
    ob.location = vec(l.get("location"), (4, -4, 6))
    ob.rotation_euler = tuple(math.radians(a) for a in vec(l.get("rotation"), (40, 0, 30)))
    sc.collection.objects.link(ob)

cam_s = S.get("camera", {})
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.lens = float(cam_s.get("lens", 50))
sc.collection.objects.link(cam)
cam.location = vec(cam_s.get("location"), (7, -7, 5))
target = Vector(vec(cam_s.get("look_at"), (0, 0, 0)))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
sc.camera = cam

world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = hexcol(S.get("background", "#202024"))
world.node_tree.nodes["Background"].inputs[1].default_value = float(S.get("ambient", 1.0))
sc.world = world

sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = max(4, min(256, int(S.get("samples", 48))))
# Distro builds of Blender sometimes lack the denoiser, and rendering then fails outright.
sc.cycles.use_denoising = bool(getattr(bpy.app.build_options, "openimagedenoise", False))
w, h = S.get("resolution", [960, 600])
sc.render.resolution_x = max(64, min(1920, int(w)))
sc.render.resolution_y = max(64, min(1920, int(h)))
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"
sc.render.filepath = out_path
bpy.ops.render.render(write_still=True)
print("FREETIME_RENDERED %d objects" % count)
`;

export interface BlenderResult {
  png: string;
  json: string;
  seconds: number;
  log: string;
}

export async function renderScene(root: string, name: string, scene: unknown, timeoutMs = 240_000): Promise<BlenderResult> {
  if (!scene || typeof scene !== "object") throw new Error("scene must be an object with objects, lights and camera");
  const base = `renders/${slug(name, "render")}`;
  const jsonPath = writeFileIn(root, `${base}.json`, JSON.stringify(scene, null, 2));
  const pngPath = resolveIn(root, `${base}.png`);
  const scriptPath = path.join(config.dataDir, "freetime-blender.py");
  fs.writeFileSync(scriptPath, BLENDER_SCRIPT);
  const cmd = await commandFor("blender");
  const started = Date.now();
  const r = await runProgram([...cmd, "--background", "--factory-startup", "--python-exit-code", "1", "--python", scriptPath, "--", jsonPath, pngPath], { timeoutMs });
  if (r.timedOut) throw new Error("The render took too long. Try fewer objects, fewer samples, or a smaller resolution.");
  if (r.code !== 0 || !fs.existsSync(pngPath)) {
    const err = r.out.split("\n").filter((l) => /Error|Traceback|line \d+/.test(l)).slice(-6).join("\n");
    throw new Error(`Blender couldn't render that scene.\n${err || r.out.slice(-800)}`);
  }
  return { png: `${base}.png`, json: `${base}.json`, seconds: Math.round((Date.now() - started) / 1000), log: r.out.match(/FREETIME_RENDERED.*/)?.[0] ?? "" };
}

// ================================================================ LilyPond

/**
 * LilyPond dropped its safe mode in 2.24, and its source can embed Scheme that runs with the
 * user's rights. So before engraving we refuse every way into running Scheme code or touching other
 * files. Plain Scheme values (#3, #'symbol, #"text", ##t, #UP) are fine; calls, quasiquotes,
 * $-expressions, includes and file-reading markup are not. This is a deny-list in front of a program
 * with no sandbox, so it's a real barrier but not a proof; it should get an OS-level sandbox later.
 */
const LY_FORBIDDEN: [RegExp, string][] = [
  [/#\s*@?\s*\(/, "Scheme expressions like #( ... ) aren't allowed. Plain values like #3, #'symbol and #\"text\" are fine."],
  [/#\s*@/, "Scheme splices (#@) aren't allowed."],
  [/\$/, "$ expressions aren't allowed."],
  [/#\s*\{/, "#{ ... #} blocks aren't allowed."],
  [/`/, "Backticks aren't allowed."],
  [/\\include\b/, "\\include isn't allowed; put everything in one score."],
  [/\\(epsfile|verbatim-file|bookOutputName|bookOutputSuffix)\b/, "That command reads or writes other files and isn't allowed."],
  [/output-(filename|suffix)/, "Changing the output file name isn't allowed."],
];

/** The source with strings and comments blanked out, scanned in one pass so neither can hide the other. */
function lilypondCode(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      out += '""';
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (c === "%" && src[i + 1] === "{") {
      const end = src.indexOf("%}", i + 2);
      i = end < 0 ? src.length : end + 1;
      out += " ";
    } else if (c === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else out += c;
  }
  return out;
}

export function checkLilypond(src: string): string | null {
  // Strings and comments can hold anything harmless, so judge only what's outside them.
  const code = lilypondCode(src);
  for (const [re, msg] of LY_FORBIDDEN) if (re.test(code)) return msg;
  return null;
}

export async function engrave(root: string, name: string, source: string): Promise<{ files: string[]; warnings: string }> {
  const base = `scores/${slug(name, "score")}`;
  const ly = String(source ?? "");
  if (!ly.trim()) throw new Error("the score is empty");
  const bad = checkLilypond(ly);
  if (bad) throw new Error(bad);
  writeFileIn(root, `${base}.ly`, ly.includes("\\version") ? ly : `\\version "2.24.0"\n${ly}`);
  const dir = resolveIn(root, "scores");
  for (const f of fs.readdirSync(dir)) if (f.startsWith(path.basename(base)) && /\.(png|pdf|midi?)$/.test(f)) fs.rmSync(path.join(dir, f));
  const cmd = await commandFor("lilypond");
  const r = await runProgram([...cmd, "-dno-point-and-click", "--pdf", "--png", "-dresolution=110", "-o", path.basename(base), `${path.basename(base)}.ly`], { cwd: dir, timeoutMs: 120_000 });
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(path.basename(base)) && /\.(png|pdf|midi?)$/.test(f))
    .map((f) => `scores/${f}`);
  const problems = r.out
    .split("\n")
    .filter((l) => /error|warning/i.test(l))
    .slice(0, 12)
    .join("\n");
  if (!files.length) throw new Error(`LilyPond couldn't engrave that.\n${problems || r.out.slice(-800)}`);
  return { files, warnings: problems };
}

// ================================================================ Chess (Stockfish over UCI)

class Uci {
  private p: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters: { re: RegExp; resolve: (s: string) => void }[] = [];

  constructor(cmd: string[]) {
    this.p = spawn(cmd[0], cmd.slice(1), { windowsHide: true });
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      for (const w of [...this.waiters]) {
        if (w.re.test(this.buf)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          const out = this.buf;
          this.buf = "";
          w.resolve(out);
        }
      }
    });
  }

  send(line: string) {
    this.p.stdin.write(line + "\n");
  }

  ask(line: string, until: RegExp, timeoutMs = 15_000): Promise<string> {
    this.buf = "";
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the chess engine didn't answer")), timeoutMs);
      this.waiters.push({
        re: until,
        resolve: (s) => {
          clearTimeout(t);
          resolve(s);
        },
      });
      this.send(line);
    });
  }

  close() {
    try {
      this.send("quit");
    } catch {}
    setTimeout(() => this.p.kill(), 500);
  }
}

export interface ChessGame {
  agentColor: "white" | "black";
  level: number;
  moves: string[];
  result?: string;
}

const GAME_FILE = "chess/current.json";

export function loadGame(root: string): ChessGame | null {
  try {
    return JSON.parse(fs.readFileSync(resolveIn(root, GAME_FILE), "utf8"));
  } catch {
    return null;
  }
}

function saveGame(root: string, g: ChessGame) {
  writeFileIn(root, GAME_FILE, JSON.stringify(g, null, 2));
  if (g.result) writeFileIn(root, `chess/game-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, JSON.stringify(g, null, 2));
}

async function position(u: Uci, moves: string[]) {
  u.send(`position startpos${moves.length ? " moves " + moves.join(" ") : ""}`);
  const perft = await u.ask("go perft 1", /Nodes searched: \d+/);
  const legal = [...perft.matchAll(/^([a-h][1-8][a-h][1-8][qrbn]?): \d+/gm)].map((m) => m[1]);
  const d = await u.ask("d", /Checkers:.*\n/);
  const board = d.split("\n").filter((l) => /^\s*[+|]|^\s+a\s+b/.test(l)).join("\n");
  const fen = d.match(/Fen: (.+)/)?.[1]?.trim() ?? "";
  const inCheck = !!d.match(/Checkers:\s*(\S+)/);
  return { legal, board, fen, inCheck };
}

function describe(g: ChessGame, pos: { board: string; fen: string; inCheck: boolean; legal: string[] }, note: string) {
  const toMove = pos.fen.split(" ")[1] === "w" ? "white" : "black";
  const lines = [note, "", pos.board, `FEN: ${pos.fen}`, `Moves so far: ${g.moves.join(" ") || "(none)"}`];
  if (g.result) lines.push(`Game over: ${g.result}`);
  else {
    lines.push(`${toMove === g.agentColor ? "Your move" : "Engine to move"} (${toMove})${pos.inCheck ? ", in check" : ""}.`);
    if (toMove === g.agentColor) lines.push(`Legal moves: ${pos.legal.join(" ")}`);
  }
  return lines.join("\n");
}

async function withEngine<T>(fn: (u: Uci) => Promise<T>): Promise<T> {
  const u = new Uci(await commandFor("stockfish"));
  try {
    await u.ask("uci", /uciok/);
    return await fn(u);
  } finally {
    u.close();
  }
}

async function engineReply(u: Uci, g: ChessGame) {
  u.send(`setoption name Skill Level value ${g.level}`);
  u.send(`position startpos${g.moves.length ? " moves " + g.moves.join(" ") : ""}`);
  const out = await u.ask(`go movetime ${300 + g.level * 60}`, /bestmove \S+/, 30_000);
  return out.match(/bestmove (\S+)/)![1];
}

function judge(g: ChessGame, pos: { legal: string[]; inCheck: boolean; fen: string }) {
  if (pos.legal.length) return;
  const loser = pos.fen.split(" ")[1] === "w" ? "white" : "black";
  g.result = pos.inCheck ? `checkmate, ${loser === "white" ? "black" : "white"} wins` : "stalemate, a draw";
}

export async function chessNew(root: string, color: string, level: number): Promise<string> {
  const g: ChessGame = { agentColor: color === "black" ? "black" : "white", level: Math.max(0, Math.min(20, Math.round(level ?? 3))), moves: [] };
  return withEngine(async (u) => {
    if (g.agentColor === "black") g.moves.push(await engineReply(u, g));
    const pos = await position(u, g.moves);
    saveGame(root, g);
    return describe(g, pos, `New game. You play ${g.agentColor} against Stockfish at level ${g.level} of 20.${g.agentColor === "black" ? ` The engine opened with ${g.moves[0]}.` : ""}`);
  });
}

export async function chessMove(root: string, move: string): Promise<string> {
  const g = loadGame(root);
  if (!g) return "No game in progress. Start one with chess_new.";
  if (g.result) return `That game is over (${g.result}). Start another with chess_new.`;
  const mv = String(move ?? "").trim().toLowerCase().replace(/[-x+#\s]/g, "");
  return withEngine(async (u) => {
    let pos = await position(u, g.moves);
    if (!pos.legal.includes(mv)) return describe(g, pos, `"${move}" isn't a legal move here. Use coordinate notation like e2e4, or e7e8q to promote.`);
    g.moves.push(mv);
    pos = await position(u, g.moves);
    judge(g, pos);
    let note = `You played ${mv}.`;
    if (!g.result) {
      const reply = await engineReply(u, g);
      g.moves.push(reply);
      pos = await position(u, g.moves);
      judge(g, pos);
      note += ` Stockfish answered ${reply}.`;
    }
    saveGame(root, g);
    return describe(g, pos, note);
  });
}

export async function chessBoard(root: string): Promise<string> {
  const g = loadGame(root);
  if (!g) return "No game in progress. Start one with chess_new.";
  return withEngine(async (u) => describe(g, await position(u, g.moves), "Current game."));
}

// ================================================================ Text adventures (dfrotz)

export const gamesDir = () => {
  const d = path.join(config.dataDir, "if-games");
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export const GAME_EXT = /\.(z[1-8]|zblorb|zlb|dat)$/i;

export function listGames(): string[] {
  return fs
    .readdirSync(gamesDir())
    .filter((f) => GAME_EXT.test(f))
    .sort();
}

interface IfSession {
  game: string;
  proc: ChildProcessWithoutNullStreams;
  out: string;
}

const ifSessions = new Map<number, IfSession>();
// Fixed seed so replaying the same commands always reaches the same place.
const SEED = "1977";

function readUntilQuiet(s: IfSession, ms = 2500): Promise<string> {
  return new Promise((resolve) => {
    let quiet: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(cap);
      s.proc.stdout.off("data", on);
      const text = s.out;
      s.out = "";
      resolve(text);
    };
    const on = () => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, 250);
    };
    const cap = setTimeout(finish, ms);
    s.proc.stdout.on("data", on);
    quiet = setTimeout(finish, 600);
  });
}

const transcriptPath = (game: string) => `adventures/${slug(game)}.commands.txt`;

async function openIf(profileId: number, root: string, game: string, replay: boolean): Promise<{ s: IfSession; intro: string }> {
  closeIf(profileId);
  const file = path.join(gamesDir(), game);
  if (!listGames().includes(game) || !fs.existsSync(file)) throw new Error(`No game called "${game}" on the shelf. Games: ${listGames().join(", ") || "(none yet)"}`);
  const cmd = await commandFor("frotz");
  // -m: no MORE prompts, -p: plain ASCII, -R: restrict save/restore files to a scratch dir, -s: fixed random seed.
  const scratch = resolveIn(root, "adventures/.saves");
  fs.mkdirSync(scratch, { recursive: true });
  const proc = spawn(cmd[0], [...cmd.slice(1), "-m", "-p", "-w", "100", "-R", scratch, "-s", SEED, file], { windowsHide: true });
  const s: IfSession = { game, proc, out: "" };
  proc.stdout.on("data", (d) => (s.out = (s.out + d).slice(-20_000)));
  proc.on("close", () => ifSessions.get(profileId) === s && ifSessions.delete(profileId));
  ifSessions.set(profileId, s);
  let intro = await readUntilQuiet(s, 4000);
  if (replay) {
    let cmds: string[] = [];
    try {
      cmds = fs.readFileSync(resolveIn(root, transcriptPath(game)), "utf8").split("\n").filter(Boolean);
    } catch {}
    for (const c of cmds) {
      proc.stdin.write(c + "\n");
      intro = await readUntilQuiet(s, 2500);
    }
    if (cmds.length) intro = `(Resumed after ${cmds.length} moves. Last thing you saw:)\n${intro}`;
  }
  return { s, intro };
}

export async function ifStart(profileId: number, root: string, game: string, fresh: boolean): Promise<string> {
  if (fresh) {
    try {
      fs.rmSync(resolveIn(root, transcriptPath(game)), { force: true });
    } catch {}
  }
  const { intro } = await openIf(profileId, root, game, !fresh);
  return clean(intro);
}

export async function ifCommand(profileId: number, root: string, command: string): Promise<string> {
  const s = ifSessions.get(profileId);
  if (!s) return "No game is running. Start one with adventure_start.";
  const c = String(command ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  if (!c) return "Type a command, like LOOK or GO NORTH.";
  if (/^(save|restore|script|unscript)\b/i.test(c)) return "Saving is automatic here; Freetime keeps your progress between sessions.";
  s.proc.stdin.write(c + "\n");
  const out = await readUntilQuiet(s);
  const t = resolveIn(root, transcriptPath(s.game));
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.appendFileSync(t, c + "\n");
  return clean(out) || "(no response)";
}

export function closeIf(profileId: number) {
  const s = ifSessions.get(profileId);
  if (!s) return;
  ifSessions.delete(profileId);
  s.proc.kill();
}

const clean = (s: string) =>
  s
    .replace(/^(Using normal formatting|Loading ).*\n/gm, "")
    .replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
