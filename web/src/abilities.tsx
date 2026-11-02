import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  abilityList,
  api,
  timeAgo,
  wsFileUrl,
  type AbilitiesData,
  type Ability,
  type CustomSkill,
  type Profile,
  type SoftwareInfo,
  type Wish,
  type WsFile,
} from "./api";
import { useLive } from "./live";
import { Field } from "./components";

const KIND_LABEL = { skill: "skill", builtin: "built-in", software: "software" } as const;

function useAbilities() {
  const [data, setData] = useState<AbilitiesData | null>(null);
  const load = useCallback(() => api.get<AbilitiesData>("/abilities").then(setData), []);
  useEffect(() => {
    load();
  }, [load]);
  useLive((m) => {
    if (m.channel !== "install") return;
    setData((d) => (d ? { ...d, software: d.software.map((s) => (s.id === m.payload.recipe ? { ...s, job: m.payload } : s)) } : d));
    if (m.payload.state === "done" || m.payload.state === "failed") load();
  });
  return { data, load };
}

export function useWishes(profileId?: number) {
  const [wishes, setWishes] = useState<Wish[]>([]);
  const load = useCallback(
    () => api.get<Wish[]>(`/wishes?status=open${profileId ? `&profile_id=${profileId}` : ""}`).then(setWishes),
    [profileId],
  );
  useEffect(() => {
    load();
  }, [load]);
  useLive((m) => {
    if (m.channel === "wish" && (!profileId || m.profileId === profileId)) load();
  });
  return { wishes, load };
}

// ---------------------------------------------------------------- wishes

export function WishList({ profileId, onChange }: { profileId?: number; onChange?: () => void }) {
  const { wishes, load } = useWishes(profileId);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (wishes.length && !names.size) api.get<AbilitiesData>("/abilities").then((d) => setNames(new Map(d.catalog.map((a) => [a.id, a.name]))));
  }, [wishes.length]);
  if (!wishes.length) return null;
  const act = async (w: Wish, action: "grant" | "dismiss") => {
    await api.post(`/wishes/${w.id}/${action}`);
    load();
    onChange?.();
  };
  return (
    <div className="wishes">
      {wishes.map((w) => {
        const known = names.get(w.ability);
        return (
          <div key={w.id} className="wish">
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              <div>
                {profileId ? null : <b>{w.profile_name} </b>}
                asked for <b>{known ?? `“${w.ability}”`}</b> <span className="small muted">{timeAgo(w.created_at)}</span>
              </div>
              {w.reason ? <div className="small wish-reason">“{w.reason}”</div> : null}
            </div>
            <div className="row" style={{ flex: "none" }}>
              <button className="sm primary" onClick={() => act(w, "grant")} title={known ? `Give ${known} to this agent` : "Mark as done"}>
                {known ? "Give it" : "Done"}
              </button>
              <button className="sm" onClick={() => act(w, "dismiss")}>
                Not now
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- abilities tab

export function AbilitiesTab({ profile, reload }: { profile: Profile; reload: () => void }) {
  const { data, load } = useAbilities();
  const [mine, setMine] = useState<string[]>(() => abilityList(profile));
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => setMine(abilityList(profile)), [profile.abilities]);
  if (!data) return <div className="empty">Loading…</div>;

  const toggle = async (id: string) => {
    const next = mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id];
    setMine(next);
    setErr("");
    try {
      await api.put(`/profiles/${profile.id}`, { abilities: next });
      reload();
    } catch (e: any) {
      setErr(e.message);
      setMine(mine);
    }
  };
  const sw = new Map(data.software.map((s) => [s.id, s]));

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="abilities-intro">
        <p>
          Choose what {profile.name} can do in its free time. It always has its browser, memory and the chatroom. Each ability here sits in a
          toolbox it can take out one at a time, which keeps things simple for small free models. Everything it makes stays in its own
          workspace folder.
        </p>
        <p className="small muted">
          Software abilities drive a real program on this computer. Freetime only installs one when you press Install, and it shows you the exact
          command first.
        </p>
      </div>
      <WishList profileId={profile.id} onChange={reload} />
      {err ? <div className="badge bad">{err}</div> : null}
      {data.shelves.map((shelf) => (
        <section key={shelf.id} className={`shelf shelf-${shelf.id}`}>
          <div className="shelf-head">
            <h2>{shelf.name}</h2>
            <span className="small muted">{shelf.blurb}</span>
          </div>
          <div className="ability-grid">
            {data.catalog
              .filter((a) => a.shelf === shelf.id)
              .map((a) => (
                <AbilityCard
                  key={a.id}
                  a={a}
                  on={mine.includes(a.id)}
                  webOff={!!a.needsWeb && !profile.web_enabled}
                  software={a.software ? sw.get(a.software) : undefined}
                  onToggle={() => toggle(a.id)}
                  onSetup={() => setOpen(open === a.id ? null : a.id)}
                  setupOpen={open === a.id}
                  games={a.id === "text-adventures" ? data.games : undefined}
                  onChanged={load}
                />
              ))}
            {shelf.id === "think"
              ? data.skills.map((s) => <SkillCard key={s.id} s={s} on={mine.includes(`skill:${s.id}`)} onToggle={() => toggle(`skill:${s.id}`)} onChanged={load} />)
              : null}
          </div>
          {shelf.id === "think" ? <NewSkill onSaved={load} /> : null}
        </section>
      ))}
    </div>
  );
}

function AbilityCard(props: {
  a: Ability;
  on: boolean;
  webOff: boolean;
  software?: SoftwareInfo;
  onToggle: () => void;
  onSetup: () => void;
  setupOpen: boolean;
  games?: string[];
  onChanged: () => void;
}) {
  const { a, on, software, webOff } = props;
  const installed = software?.detected.installed;
  const job = software?.job;
  return (
    <div className={`ability ${on ? "on" : ""} ${a.later ? "later" : ""}`}>
      <div className="row between" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="ability-kind">{KIND_LABEL[a.kind]}</span>
          <h3>{a.name}</h3>
        </div>
        {a.later ? (
          <span className="badge">coming later</span>
        ) : (
          <label className="switch" title={on ? "Take it away" : "Give it"}>
            <input type="checkbox" checked={on} onChange={props.onToggle} />
            <span />
          </label>
        )}
      </div>
      <p>{a.summary}</p>
      {a.joke ? <p className="joke">{a.joke}</p> : null}
      <div className="row" style={{ marginTop: "auto" }}>
        {a.default ? <span className="badge">on by default</span> : null}
        {a.alwaysOut ? <span className="badge">always out</span> : null}
        {webOff ? <span className="badge bad">needs web access</span> : null}
        {software ? (
          installed ? (
            <span className="badge ok" title={software.detected.version ?? ""}>
              ✓ {software.name} installed
            </span>
          ) : job && (job.state === "running" || job.state === "verifying") ? (
            <span className="badge accent">installing…</span>
          ) : (
            <span className="badge warn">{software.name} not installed</span>
          )
        ) : null}
        {software && !a.later ? (
          <button className="sm" onClick={props.onSetup}>
            {props.setupOpen ? "Close" : installed ? "Details" : "Set up"}
          </button>
        ) : null}
      </div>
      {software && props.setupOpen ? <SoftwarePanel s={software} onChanged={props.onChanged} /> : null}
      {props.games && props.setupOpen ? <GameShelf games={props.games} onChanged={props.onChanged} /> : null}
    </div>
  );
}

function SoftwarePanel({ s, onChanged }: { s: SoftwareInfo; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState("");
  const [checking, setChecking] = useState(false);
  const job = s.job;
  const busy = job && (job.state === "running" || job.state === "verifying");
  // An old successful job means nothing once the program is gone again.
  const showJob = job && (busy || job.state === "failed" || s.detected.installed);
  const check = async () => {
    setChecking(true);
    await api.post(`/software/${s.id}/check`).catch(() => {});
    setChecking(false);
    onChanged();
  };
  const install = async () => {
    setErr("");
    try {
      await api.post(`/software/${s.id}/install`);
      setConfirming(false);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="setup">
      <dl>
        <dt>What it is</dt>
        <dd>
          {s.about}{" "}
          <a href={s.homepage} target="_blank" rel="noreferrer">
            Official site
          </a>
        </dd>
        <dt>Size</dt>
        <dd>{s.size}</dd>
        <dt>What the agent can reach</dt>
        <dd>{s.touches}</dd>
        {s.detected.installed ? (
          <>
            <dt>On this computer</dt>
            <dd className="mono">{s.detected.version || "installed"}</dd>
          </>
        ) : null}
      </dl>
      {!s.detected.installed && !busy ? (
        s.plan.ok ? (
          confirming ? (
            <div className="confirm">
              <div>Freetime will run this on your computer:</div>
              <code className="cmd">{s.plan.command?.join(" ")}</code>
              <div className="small muted">Your computer may ask for permission. The install can take a few minutes; you can leave this page.</div>
              <div className="row">
                <button className="primary" onClick={install}>
                  Install {s.name}
                </button>
                <button onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="primary" onClick={() => setConfirming(true)}>
                Install…
              </button>
              <button onClick={check} disabled={checking}>
                {checking ? "Checking…" : "Check again"}
              </button>
            </div>
          )
        ) : (
          <div className="confirm">
            <div>{s.plan.reason}</div>
            <div className="row">
              <a className="btn primary" href={s.plan.manualUrl} target="_blank" rel="noreferrer">
                Open download page
              </a>
              <button onClick={check} disabled={checking}>
                {checking ? "Checking…" : "Check again"}
              </button>
            </div>
          </div>
        )
      ) : null}
      {job && showJob ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small">
            {job.state === "running" ? "Installing…" : job.state === "verifying" ? "Installed. Testing it…" : job.state === "done" ? "✓ Installed and tested." : `✗ ${job.error}`}
          </div>
          <pre className="install-log">{job.log.slice(-3000)}</pre>
        </div>
      ) : null}
      {err ? <div className="badge bad">{err}</div> : null}
    </div>
  );
}

function GameShelf({ games, onChanged }: { games: string[]; onChanged: () => void }) {
  const [err, setErr] = useState("");
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErr("");
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      await api.post("/if-games", { name: f.name, data: btoa(bin) });
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="setup">
      <div className="small">
        <b>Games shelf</b> (shared by all agents). Add Z-machine story files (.z3, .z5, .z8, .zblorb). The{" "}
        <a href="https://ifdb.org/" target="_blank" rel="noreferrer">
          IFDB
        </a>{" "}
        and the IF Archive list many free ones; check each game's licence.
      </div>
      {games.length ? (
        <ul className="games">
          {games.map((g) => (
            <li key={g} className="row between">
              <span className="mono">{g}</span>
              <button
                className="sm ghost"
                onClick={async () => {
                  await api.del(`/if-games/${encodeURIComponent(g)}`);
                  onChanged();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="small muted">No games yet.</div>
      )}
      <label className="btn sm" style={{ alignSelf: "flex-start" }}>
        Add a story file
        <input type="file" accept=".z3,.z4,.z5,.z8,.zblorb,.zlb" onChange={upload} hidden />
      </label>
      {err ? <div className="badge bad">{err}</div> : null}
    </div>
  );
}

function SkillCard({ s, on, onToggle, onChanged }: { s: CustomSkill; on: boolean; onToggle: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <SkillEditor skill={s} onDone={() => (setEditing(false), onChanged())} />;
  return (
    <div className={`ability ${on ? "on" : ""}`}>
      <div className="row between" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="ability-kind">your skill</span>
          <h3>{s.name}</h3>
        </div>
        <label className="switch">
          <input type="checkbox" checked={on} onChange={onToggle} />
          <span />
        </label>
      </div>
      <p>{s.description || <span className="muted">No description.</span>}</p>
      <div className="row" style={{ marginTop: "auto" }}>
        <button className="sm" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
    </div>
  );
}

function NewSkill({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button style={{ alignSelf: "flex-start", marginTop: 10 }} onClick={() => setOpen(true)}>
        + Write a skill
      </button>
    );
  return (
    <div style={{ marginTop: 10 }}>
      <SkillEditor onDone={() => (setOpen(false), onSaved())} />
    </div>
  );
}

function SkillEditor({ skill, onDone }: { skill?: CustomSkill; onDone: () => void }) {
  const [f, setF] = useState({ name: skill?.name ?? "", description: skill?.description ?? "", body: skill?.body ?? "" });
  const [err, setErr] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (skill) await api.put(`/skills/${skill.id}`, f);
      else await api.post("/skills", f);
      onDone();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <form className="card form" onSubmit={save}>
      <div className="small muted">
        A skill is a short Markdown practice. The agent sees the name and one-line description, and reads the rest when it opens it. It's text
        only, so it can't run anything.
      </div>
      <Field label="Name">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={60} placeholder="e.g. Haiku walk" />
      </Field>
      <Field label="One line on what it is">
        <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} />
      </Field>
      <Field label="The practice (Markdown)">
        <textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={8} className="mono" />
      </Field>
      {err ? <div className="badge bad">{err}</div> : null}
      <div className="row">
        <button className="primary" type="submit">
          Save skill
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        {skill ? (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!confirm(`Delete the skill “${skill.name}”? Agents that have it lose it.`)) return;
              await api.del(`/skills/${skill.id}`);
              onDone();
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- workspace / gallery

const IMAGE = /\.(png|jpe?g|webp|svg)$/i;

export function WorkspaceTab({ profile }: { profile: Profile }) {
  const [files, setFiles] = useState<WsFile[] | null>(null);
  const [view, setView] = useState<WsFile | null>(null);
  const [text, setText] = useState("");
  const load = useCallback(() => api.get<WsFile[]>(`/profiles/${profile.id}/workspace`).then(setFiles), [profile.id]);
  useEffect(() => {
    load();
  }, [load]);
  useLive((m) => {
    if (m.channel === "event" && m.profileId === profile.id && m.payload.type === "tool_result") load();
  });
  useEffect(() => {
    if (!view || IMAGE.test(view.path)) return;
    fetch(wsFileUrl(profile.id, view.path))
      .then((r) => r.text())
      .then(setText);
  }, [view?.path, view?.modified]);
  if (!files) return <div className="empty">Loading…</div>;
  const images = files.filter((f) => IMAGE.test(f.path)).sort((a, b) => b.modified - a.modified);
  const others = files.filter((f) => !IMAGE.test(f.path) && !f.path.startsWith("books/") && !f.path.startsWith("adventures/"));
  if (!files.length)
    return (
      <div className="card empty">
        {profile.name}'s workspace is empty. Drawings, renders, scores and writing show up here as it makes them.
      </div>
    );
  return (
    <div className="stack" style={{ gap: 18 }}>
      {images.length ? (
        <div className="gallery">
          {images.map((f) => (
            <button key={f.path} className="gallery-item" onClick={() => setView(f)} title={f.path}>
              <img src={`${wsFileUrl(profile.id, f.path)}&v=${Math.round(f.modified)}`} alt={f.path} loading="lazy" />
              <span>{f.path.split("/").pop()}</span>
            </button>
          ))}
        </div>
      ) : null}
      {others.length ? (
        <div className="card">
          <h2>Files</h2>
          <table>
            <tbody>
              {others.map((f) => (
                <tr key={f.path}>
                  <td className="mono">
                    {/\.(pdf|midi?)$/i.test(f.path) ? (
                      <a href={wsFileUrl(profile.id, f.path, true)}>{f.path}</a>
                    ) : (
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setView(f);
                        }}
                      >
                        {f.path}
                      </a>
                    )}
                  </td>
                  <td className="small muted">{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</td>
                  <td className="small muted">{timeAgo(f.modified)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {view ? (
        <div className="lightbox" onClick={() => setView(null)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <span className="mono">{view.path}</span>
              <div className="row">
                <a className="btn sm" href={wsFileUrl(profile.id, view.path, true)}>
                  Download
                </a>
                <button className="sm" onClick={() => setView(null)}>
                  Close
                </button>
              </div>
            </div>
            {IMAGE.test(view.path) ? <img src={`${wsFileUrl(profile.id, view.path)}&v=${Math.round(view.modified)}`} alt={view.path} /> : <pre className="ws-text">{text}</pre>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
