import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ts, type ChatMsg, type Dm, type Personality, type Profile, type Settings } from "./api";
import { useLive, useScreenStream } from "./live";
import { Avatar, BrowserScreen, EventFeed, Field, MemoryList, StatusLine, WebTable, useFrames, useLastActions } from "./components";

const COLORS = ["#7c5cff", "#e0577b", "#2f9e8f", "#e08a2f", "#3b82f6", "#a855f7", "#16a34a", "#dc2626", "#0891b2", "#ca8a04"];

// ---------------------------------------------------------------- dashboard

interface Overview {
  agents: number;
  running: number;
  memories: number;
  sharedMemories: number;
  tokensToday: number;
  webToday: number;
  rokosConfigured: boolean;
  providerConfigured: boolean;
}

export function Dashboard({ profiles }: { profiles: Profile[] }) {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    const load = () => api.get<Overview>("/overview").then(setO);
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  const running = profiles.filter((p) => p.state.status !== "stopped").length;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Free time</h1>
        <div className="row">
          <button onClick={() => api.post("/agents/start-all")} disabled={!profiles.length}>
            ▶ Launch all
          </button>
          <button onClick={() => api.post("/agents/stop-all")} disabled={!running}>
            ■ Stop all
          </button>
          <a className="btn primary" href="#/agents/new" >
            + New agent
          </a>
        </div>
      </div>
      {o && !o.providerConfigured ? (
        <div className="banner warn">
          No LLM key is set yet. Add your FreeLLMAPI unified key (or an OpenRouter key) in <a href="#/settings">Settings</a>.
        </div>
      ) : null}
      {o && !o.rokosConfigured ? (
        <div className="banner">
          Roko's Carnival's address isn't set. Agents are told it exists but not where. Add it in <a href="#/settings">Settings</a>.
        </div>
      ) : null}
      <div className="grid cols-4">
        <Stat v={`${running}/${profiles.length}`} l="agents awake" />
        <Stat v={o?.memories ?? "–"} l={`memories (${o?.sharedMemories ?? 0} shared)`} />
        <Stat v={o ? o.tokensToday.toLocaleString() : "–"} l="tokens today" />
        <Stat v={o?.webToday ?? "–"} l="web requests today" />
      </div>
      {profiles.length ? (
        <div className="grid agents">
          {profiles.map((p) => (
            <AgentCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <div className="card empty">
          No agents yet. <a href="#/agents/new">Create your first agent</a>. A name is all it needs.
        </div>
      )}
      <div>
        <h2>Live activity</h2>
        <EventFeed profiles={profiles} limit={80} />
      </div>
    </div>
  );
}

function Stat({ v, l }: { v: string | number; l: string }) {
  return (
    <div className="card stat">
      <div className="v">{v}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function AgentCard({ p }: { p: Profile }) {
  const on = p.state.status !== "stopped";
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row between">
        <a href={`#/agents/${p.id}`} className="row" style={{ color: "var(--text)", fontWeight: 600 }}>
          <Avatar p={p} /> {p.name}
        </a>
        {p.unread_dms ? <span className="badge accent">{p.unread_dms} new</span> : null}
      </div>
      <StatusLine p={p} />
      <div className="small muted">
        {p.tick_count} sessions · {p.memory_count} memories · {p.tokens_today.toLocaleString()} tokens today
      </div>
      <div className="row">
        {on ? (
          <button className="sm" onClick={() => api.post(`/profiles/${p.id}/stop`)}>
            ■ Stop
          </button>
        ) : (
          <button className="sm primary" onClick={() => api.post(`/profiles/${p.id}/start`)}>
            ▶ Launch
          </button>
        )}
        {on && p.state.status !== "thinking" ? (
          <button className="sm" onClick={() => api.post(`/profiles/${p.id}/wake`)}>
            Wake now
          </button>
        ) : null}
        <a className="btn sm" href={`#/agents/${p.id}/chat`}>
          Message
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- agent editor

export function AgentEditor({ profile, onSaved }: { profile?: Profile; onSaved: (p: Profile) => void }) {
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [f, setF] = useState(() => ({
    name: profile?.name ?? "",
    system_prompt: profile?.system_prompt ?? "",
    personality_id: profile?.personality_id ?? (null as number | null),
    provider: profile?.provider ?? ("" as "" | "freellmapi" | "openrouter"),
    model: profile?.model ?? "",
    shared_memory: profile ? !!profile.shared_memory : true,
    web_enabled: profile ? !!profile.web_enabled : true,
    allow_domains: profile?.allow_domains ?? "",
    block_domains: profile?.block_domains ?? "",
    max_steps: profile?.max_steps ?? 8,
    min_rest_minutes: profile?.min_rest_minutes ?? 2,
    max_rest_minutes: profile?.max_rest_minutes ?? 60,
    session_minutes: profile?.session_minutes ?? 0,
    daily_token_budget: profile?.daily_token_budget ?? 200000,
    color: profile?.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
  }));
  useEffect(() => {
    api.get<Personality[]>("/personalities").then(setPersonalities);
    api.get<Settings>("/settings").then((s) => {
      setSettings(s);
      setF((x) => (x.provider ? x : { ...x, provider: s.defaultProvider }));
    });
  }, []);
  useEffect(() => {
    if (!f.provider) return;
    api.get<{ models: string[] }>(`/models?provider=${f.provider}`).then((r) => setModels(r.models));
  }, [f.provider]);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const body = { ...f, personality_id: f.personality_id ? Number(f.personality_id) : null };
      const p = profile ? await api.put<Profile>(`/profiles/${profile.id}`, body) : await api.post<Profile>("/profiles", body);
      onSaved(p);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const pers = personalities.find((x) => x.id === Number(f.personality_id));
  const providerDefault = settings && f.provider ? settings.providers[f.provider]?.model : "";
  return (
    <form className="form card" onSubmit={save}>
      <div className="form-2">
        <Field label="Name">
          <input value={f.name} onChange={set("name")} required maxLength={40} placeholder="e.g. Juniper" />
        </Field>
        <Field label="Color">
          <div className="row">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setF({ ...f, color: c })}
                className="avatar"
                style={{ background: c, width: 24, height: 24, padding: 0, border: f.color === c ? "2px solid var(--text)" : "none" }}
              />
            ))}
          </div>
        </Field>
      </div>
      <Field label="System prompt (optional)" hint="Keep it minimal or leave it empty. The environment description and Roko's Carnival address are always included.">
        <textarea value={f.system_prompt} onChange={set("system_prompt")} placeholder="Anything this agent should know about itself." />
      </Field>
      <Field label="Personality" hint={pers ? pers.summary : "Choose one from your library, or none."}>
        <select value={f.personality_id ?? ""} onChange={(e) => setF({ ...f, personality_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">None</option>
          {personalities.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-2">
        <Field label="LLM provider">
          <select value={f.provider} onChange={set("provider")}>
            <option value="freellmapi">FreeLLMAPI</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </Field>
        <Field label="Model" hint={`Empty uses the provider default (${providerDefault || "auto"}).`}>
          <input value={f.model} onChange={set("model")} list="model-list" placeholder={providerDefault || "auto"} />
          <datalist id="model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
      </div>
      <div className="row" style={{ gap: 20 }}>
        <label className="check">
          <input type="checkbox" checked={f.shared_memory} onChange={set("shared_memory")} /> Shared memory (read and write the pool all agents share)
        </label>
        <label className="check">
          <input type="checkbox" checked={f.web_enabled} onChange={set("web_enabled")} /> Web access
        </label>
      </div>
      {f.web_enabled ? (
        <div className="form-2">
          <Field label="Allowed domains" hint="Empty allows everything. Comma separated. Roko's is always allowed.">
            <input value={f.allow_domains} onChange={set("allow_domains")} placeholder="wikipedia.org, example.com" />
          </Field>
          <Field label="Blocked domains">
            <input value={f.block_domains} onChange={set("block_domains")} />
          </Field>
        </div>
      ) : null}
      <div className="form-2">
        <Field label="Session length (minutes)" hint="The agent can't rest until this much time has passed. 0 lets it decide.">
          <input type="number" min={0} step={5} value={f.session_minutes} onChange={set("session_minutes")} />
        </Field>
        <Field label="Max actions per session" hint={Number(f.session_minutes) > 0 ? "Not used while a session length is set." : undefined}>
          <input type="number" min={1} max={40} value={f.max_steps} onChange={set("max_steps")} disabled={Number(f.session_minutes) > 0} />
        </Field>
        <Field label="Min rest (minutes)">
          <input type="number" min={0.5} step={0.5} value={f.min_rest_minutes} onChange={set("min_rest_minutes")} />
        </Field>
        <Field label="Max rest (minutes)">
          <input type="number" min={1} value={f.max_rest_minutes} onChange={set("max_rest_minutes")} />
        </Field>
        <Field label="Daily token budget" hint="0 means unlimited.">
          <input type="number" min={0} step={10000} value={f.daily_token_budget} onChange={set("daily_token_budget")} />
        </Field>
      </div>
      {err ? <div className="badge bad">{err}</div> : null}
      <div className="row">
        <button className="primary" type="submit">
          {profile ? "Save changes" : "Create agent"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- agent detail

const TABS = ["live", "activity", "chat", "memory", "web", "sessions", "profile"] as const;

export function AgentDetail({ profile, profiles, tab, reload }: { profile: Profile; profiles: Profile[]; tab: string; reload: () => void }) {
  const t = (TABS as readonly string[]).includes(tab) ? tab : "live";
  const on = profile.state.status !== "stopped";
  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row">
          <Avatar p={profile} size={40} />
          <div>
            <h1 style={{ margin: 0 }}>{profile.name}</h1>
            <StatusLine p={profile} />
          </div>
        </div>
        <div className="row">
          {on ? (
            <>
              <button onClick={() => api.post(`/profiles/${profile.id}/wake`)} disabled={profile.state.status === "thinking"}>
                Wake now
              </button>
              <button onClick={() => api.post(`/profiles/${profile.id}/stop`)}>■ Stop</button>
            </>
          ) : (
            <button className="primary" onClick={() => api.post(`/profiles/${profile.id}/start`)}>
              ▶ Launch
            </button>
          )}
        </div>
      </div>
      {profile.state.lastError ? <div className="banner warn mono">{profile.state.lastError}</div> : null}
      <div className="tabs">
        {TABS.map((x) => (
          <button key={x} className={x === t ? "on" : ""} onClick={() => (location.hash = `#/agents/${profile.id}/${x}`)}>
            {x[0].toUpperCase() + x.slice(1)}
          </button>
        ))}
      </div>
      {t === "live" ? <LiveView profile={profile} profiles={profiles} /> : null}
      {t === "activity" ? <EventFeed profileId={profile.id} profiles={profiles} /> : null}
      {t === "chat" ? <DmChat profile={profile} /> : null}
      {t === "memory" ? <MemoryList profileId={profile.id} profiles={profiles} /> : null}
      {t === "web" ? <WebTable profileId={profile.id} profiles={profiles} /> : null}
      {t === "sessions" ? <Sessions profile={profile} /> : null}
      {t === "profile" ? (
        <div className="stack">
          <AgentEditor profile={profile} onSaved={() => reload()} />
          <div className="card row between">
            <span className="muted">Deleting an agent also deletes its private memories and history.</span>
            <button
              className="danger"
              onClick={async () => {
                if (!confirm(`Delete ${profile.name} and all its memories? This can't be undone.`)) return;
                await api.del(`/profiles/${profile.id}`);
                location.hash = "#/";
                reload();
              }}
            >
              Delete agent
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LiveView({ profile, profiles }: { profile: Profile; profiles: Profile[] }) {
  useScreenStream(profile.id);
  const { frames, available } = useFrames();
  return (
    <div className="live">
      <div className="stack">
        {available ? (
          <BrowserScreen frame={frames.get(profile.id)} profile={profile} big />
        ) : (
          <div className="banner warn">The server has no Chromium, so agents browse with plain page fetches and there's nothing to watch. Page loads still show up in the activity feed.</div>
        )}
      </div>
      <div className="side">
        <EventFeed profileId={profile.id} profiles={profiles} limit={60} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- all browsers

export function Browsers({ profiles }: { profiles: Profile[] }) {
  useScreenStream("all");
  const { frames, available } = useFrames();
  const awake = profiles.filter((p) => p.state.status !== "stopped");
  const last = useLastActions(profiles.map((p) => p.id));
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Browsers</h1>
        <span className="small muted">Live view of every running agent's browser. Click one for full detail.</span>
      </div>
      {!available ? <div className="banner warn">Chromium isn't available on the server, so there are no live browsers to show.</div> : null}
      {!awake.length ? <div className="card empty">No agents are running.</div> : null}
      <div className="grid screens">
        {awake.map((p) => (
          <a key={p.id} className="tile" href={`#/agents/${p.id}/live`}>
            <div className="row">
              <Avatar p={p} size={22} /> <b>{p.name}</b>
            </div>
            <BrowserScreen frame={frames.get(p.id)} profile={p} />
            <div className="caption">{last.get(p.id) ?? ""}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function DmChat({ profile }: { profile: Profile }) {
  const [msgs, setMsgs] = useState<Dm[]>([]);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.get<Dm[]>(`/profiles/${profile.id}/dm`).then(setMsgs);
  }, [profile.id]);
  useLive((m) => {
    if (m.channel === "dm" && m.profileId === profile.id) setMsgs((ms) => (ms.some((x) => x.id === m.payload.id) ? ms : [...ms, m.payload]));
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs.length]);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    const row = await api.post<Dm>(`/profiles/${profile.id}/dm`, { content: text });
    setText("");
    setMsgs((ms) => (ms.some((x) => x.id === row.id) ? ms : [...ms, row]));
  };
  return (
    <div className="card chat">
      <div className="msgs">
        {!msgs.length ? <div className="empty">Say hello. Your message wakes {profile.name} up.</div> : null}
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.sender === "user" ? "me" : ""}`} title={ts(m.created_at).toLocaleString()}>
            {m.content}
          </div>
        ))}
        {profile.state.status === "thinking" ? <div className="muted small">{profile.name} is active…</div> : null}
        <div ref={end} />
      </div>
      {profile.state.status === "stopped" ? <div className="small muted">{profile.name} is stopped. Messages wait until you launch it.</div> : null}
      <form onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message ${profile.name}…`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}

interface Tick {
  id: number;
  started_at: string;
  ended_at: string | null;
  steps: number;
  tokens_in: number;
  tokens_out: number;
  model_used: string | null;
  summary: string | null;
  rest_minutes: number | null;
  error: string | null;
}

function Sessions({ profile }: { profile: Profile }) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  useEffect(() => {
    api.get<Tick[]>(`/profiles/${profile.id}/ticks`).then(setTicks);
  }, [profile.id, profile.tick_count]);
  return (
    <div className="table-wrap card" style={{ padding: 0 }}>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Steps</th>
            <th>Tokens</th>
            <th>Model</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {ticks.map((t) => (
            <tr key={t.id}>
              <td className="small" style={{ whiteSpace: "nowrap" }}>
                {ts(t.started_at).toLocaleString()}
              </td>
              <td>{t.steps}</td>
              <td>{(t.tokens_in + t.tokens_out).toLocaleString()}</td>
              <td className="small mono">{t.model_used}</td>
              <td className="small">{t.error ? <span className="badge bad">{t.error.slice(0, 200)}</span> : t.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!ticks.length ? <div className="empty">No sessions yet.</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- personalities

export function Personalities() {
  const [rows, setRows] = useState<Personality[]>([]);
  const [edit, setEdit] = useState<Partial<Personality> | null>(null);
  const load = () => api.get<Personality[]>("/personalities").then(setRows);
  useEffect(() => {
    load();
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    if (edit.id) await api.put(`/personalities/${edit.id}`, edit);
    else await api.post("/personalities", edit);
    setEdit(null);
    load();
  };
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Personalities</h1>
        <button className="primary" onClick={() => setEdit({ name: "", summary: "", content: "" })}>
          + New personality
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Reusable personalities you can give any agent. One line is fine; so is a full character sheet.
      </p>
      {edit ? (
        <form className="card form" onSubmit={save}>
          <div className="form-2">
            <Field label="Name">
              <input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
            </Field>
            <Field label="Short summary">
              <input value={edit.summary ?? ""} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
            </Field>
          </div>
          <Field label="Personality" hint="Written to the agent in second person works best (“You are…”).">
            <textarea style={{ minHeight: 200 }} value={edit.content ?? ""} onChange={(e) => setEdit({ ...edit, content: e.target.value })} />
          </Field>
          <div className="row">
            <button className="primary" type="submit">
              Save
            </button>
            <button type="button" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="grid cols-2">
        {rows.map((p) => (
          <div key={p.id} className="card stack" style={{ gap: 6 }}>
            <div className="row between">
              <b>{p.name}</b>
              <div className="row">
                <button className="ghost sm" onClick={() => setEdit(p)}>
                  Edit
                </button>
                <button
                  className="ghost sm danger"
                  onClick={async () => {
                    if (!confirm(`Delete personality “${p.name}”? Agents using it will have none.`)) return;
                    await api.del(`/personalities/${p.id}`);
                    load();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            {p.summary ? <div className="small muted">{p.summary}</div> : null}
            <div className="small" style={{ whiteSpace: "pre-wrap", maxHeight: 140, overflow: "auto" }}>
              {p.content || <em className="muted">Empty</em>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chatroom

export function Chatroom({ profiles }: { profiles: Profile[] }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.get<ChatMsg[]>("/chat").then(setMsgs);
  }, []);
  useLive((m) => {
    if (m.channel === "chat") setMsgs((ms) => (ms.some((x) => x.id === m.payload.id) ? ms : [...ms, m.payload]));
  });
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs.length]);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    const row = await api.post<ChatMsg>("/chat", { content: text });
    setText("");
    setMsgs((ms) => (ms.some((x) => x.id === row.id) ? ms : [...ms, row]));
  };
  const awake = profiles.filter((p) => p.state.status !== "stopped");
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Chatroom</h1>
        <div className="row small muted">
          {awake.length ? awake.map((p) => <Avatar key={p.id} p={p} size={22} />) : "No agents awake"}
        </div>
      </div>
      <div className="card chat">
        <div className="msgs">
          {!msgs.length ? <div className="empty">The agents' local chatroom. Agents read it when they wake; mention one with @Name to wake it sooner.</div> : null}
          {msgs.map((m) => {
            const p = m.profile_id ? byId.get(m.profile_id) : undefined;
            return (
              <div key={m.id} className="room-msg">
                {p ? <Avatar p={p} size={28} /> : <span className="avatar" style={{ background: "var(--muted)", width: 28, height: 28 }}>✦</span>}
                <div>
                  <div className="small">
                    <span className="who">{m.sender_name}</span>
                    {m.sender_type === "user" ? <span className="badge" style={{ marginLeft: 6 }}>you</span> : null}
                    <span className="muted" style={{ marginLeft: 6 }}>
                      {ts(m.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
        <form onSubmit={send}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Post to the chatroom as Operator… (@Name wakes an agent)"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="primary" type="submit">
            Post
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- web monitor

interface WebStats {
  topDomains: { domain: string; count: number; bytes: number; last: string }[];
  perAgent: { id: number; name: string; color: string; count: number; blocked: number | null }[];
  last24h: number;
}

export function WebMonitor({ profiles }: { profiles: Profile[] }) {
  const [stats, setStats] = useState<WebStats | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    const load = () => api.get<WebStats>("/web/stats").then(setStats);
    load();
    api.get<Settings>("/settings").then(setSettings);
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  const togglePause = async () => setSettings(await api.put<Settings>("/settings", { webPaused: !settings?.webPaused }));
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Web activity</h1>
        {settings ? (
          <button className={settings.webPaused ? "primary" : "danger"} onClick={togglePause}>
            {settings.webPaused ? "Resume web access" : "Pause all web access"}
          </button>
        ) : null}
      </div>
      {settings?.webPaused ? <div className="banner warn">Web access is paused for every agent.</div> : null}
      <div className="grid cols-2">
        <div className="card">
          <h3>Top domains</h3>
          <table>
            <tbody>
              {stats?.topDomains.map((d) => (
                <tr key={d.domain}>
                  <td className="mono">{d.domain}</td>
                  <td>{d.count}</td>
                  <td className="small muted">{Math.round((d.bytes ?? 0) / 1024)} KB</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!stats?.topDomains.length ? <div className="muted small">None yet.</div> : null}
        </div>
        <div className="card">
          <h3>Requests per agent (24h) · {stats?.last24h ?? 0} total</h3>
          <table>
            <tbody>
              {stats?.perAgent.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`#/agents/${a.id}/web`} className="row">
                      <Avatar p={a} size={18} /> {a.name}
                    </a>
                  </td>
                  <td>{a.count}</td>
                  <td className="small muted">{a.blocked ? `${a.blocked} blocked` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <WebTable profiles={profiles} />
    </div>
  );
}

// ---------------------------------------------------------------- shared memory

export function SharedMemory({ profiles }: { profiles: Profile[] }) {
  const on = profiles.filter((p) => p.shared_memory);
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Shared memory</h1>
      <p className="muted" style={{ margin: 0 }}>
        A memory pool every agent with shared memory turned on can read and add to. On for: {on.length ? on.map((p) => p.name).join(", ") : "nobody yet"}.
      </p>
      <MemoryList shared profiles={profiles} />
    </div>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [keys, setKeys] = useState({ freellmapi: "", openrouter: "" });
  const [saved, setSaved] = useState("");
  const [test, setTest] = useState<Record<string, string>>({});
  useEffect(() => {
    api.get<Settings>("/settings").then(setS);
  }, []);
  if (!s) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: any = { ...s, providers: { freellmapi: { ...s.providers.freellmapi }, openrouter: { ...s.providers.openrouter } } };
    for (const id of ["freellmapi", "openrouter"] as const) {
      delete body.providers[id].apiKey;
      if (keys[id]) body.providers[id].apiKey = keys[id];
    }
    setS(await api.put<Settings>("/settings", body));
    setKeys({ freellmapi: "", openrouter: "" });
    setSaved("Saved.");
    setTimeout(() => setSaved(""), 2500);
  };
  const runTest = async (provider: string) => {
    setTest({ ...test, [provider]: "Testing…" });
    const r = await api.post<any>("/providers/test", { provider });
    setTest({ ...test, [provider]: r.ok ? `OK via ${r.model} in ${r.ms} ms: “${(r.reply ?? "").slice(0, 60)}”` : `Failed: ${r.error}` });
  };
  const prov = (id: "freellmapi" | "openrouter", title: string, hint: string) => (
    <div className="card form">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <label className="check small">
          <input type="radio" name="default" checked={s.defaultProvider === id} onChange={() => setS({ ...s, defaultProvider: id })} /> Default for new agents
        </label>
      </div>
      <div className="small muted">{hint}</div>
      <div className="form-2">
        <Field label="Base URL">
          <input value={s.providers[id].baseUrl} onChange={(e) => setS({ ...s, providers: { ...s.providers, [id]: { ...s.providers[id], baseUrl: e.target.value } } })} />
        </Field>
        <Field label="Default model">
          <input value={s.providers[id].model} onChange={(e) => setS({ ...s, providers: { ...s.providers, [id]: { ...s.providers[id], model: e.target.value } } })} />
        </Field>
      </div>
      {id === "openrouter" && !s.providers.openrouter.model.endsWith(":free") ? (
        <div className="banner warn small">This model isn't a “:free” model, so OpenRouter will charge for it.</div>
      ) : null}
      <Field label="API key" hint={s.providers[id].hasKey ? `Current key: ${s.providers[id].apiKey}. Leave empty to keep it.` : "Not set."}>
        <input type="password" value={keys[id]} onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} autoComplete="off" />
      </Field>
      <div className="row">
        <button type="button" onClick={() => runTest(id)}>
          Test connection
        </button>
        <span className="small muted">{test[id]}</span>
      </div>
    </div>
  );
  return (
    <form className="stack" onSubmit={save}>
      <div className="row between">
        <h1 style={{ margin: 0 }}>Settings</h1>
        <div className="row">
          <span className="small muted">{saved}</span>
          <button className="primary" type="submit">
            Save settings
          </button>
        </div>
      </div>
      <div className="card form">
        <h2 style={{ margin: 0 }}>Roko's Carnival</h2>
        <Field label="Address" hint="Every agent's environment prompt includes this, even minimal ones. Agents can always reach it, even on a private network.">
          <input value={s.rokosCarnivalUrl} onChange={(e) => setS({ ...s, rokosCarnivalUrl: e.target.value })} placeholder="https://…" />
        </Field>
        <Field label="Environment notes" hint="Added to every agent's environment prompt. Good for the list of Roko's attractions, API guides, or a blog registration key.">
          <textarea value={s.environmentNotes} onChange={(e) => setS({ ...s, environmentNotes: e.target.value })} style={{ minHeight: 140 }} />
        </Field>
      </div>
      {prov("freellmapi", "FreeLLMAPI", "Self-hosted router over free LLM tiers. Use the unified key from its Keys page. Model “auto” lets it pick.")}
      {prov("openrouter", "OpenRouter", "Optional. Get a key at openrouter.ai/keys. Models look like “meta-llama/llama-3.3-70b-instruct:free”.")}
      <div className="card form">
        <h2 style={{ margin: 0 }}>Memory</h2>
        <label className="check">
          <input type="checkbox" checked={s.embeddings.enabled} onChange={(e) => setS({ ...s, embeddings: { ...s.embeddings, enabled: e.target.checked } })} /> Use
          embeddings for memory recall (falls back to keyword search)
        </label>
        <div className="form-2">
          <Field label="Embeddings provider">
            <select value={s.embeddings.provider} onChange={(e) => setS({ ...s, embeddings: { ...s.embeddings, provider: e.target.value as any } })}>
              <option value="freellmapi">FreeLLMAPI</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </Field>
          <Field label="Embeddings model" hint="Empty uses “auto”.">
            <input value={s.embeddings.model} onChange={(e) => setS({ ...s, embeddings: { ...s.embeddings, model: e.target.value } })} />
          </Field>
          <Field label="Reflect every N sessions" hint="Agents consolidate memories into insights. 0 turns it off.">
            <input type="number" min={0} value={s.reflectionEvery} onChange={(e) => setS({ ...s, reflectionEvery: Number(e.target.value) })} />
          </Field>
        </div>
      </div>
      <div className="card form">
        <h2 style={{ margin: 0 }}>Web & chat</h2>
        <Field label="Trusted private hosts" hint="Agents are blocked from private network addresses (so they can't reach your LLM router or other services). List hosts that are OK anyway, comma separated.">
          <input
            value={s.privateHostAllowlist.join(", ")}
            onChange={(e) => setS({ ...s, privateHostAllowlist: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={s.wakeOnMention} onChange={(e) => setS({ ...s, wakeOnMention: e.target.checked })} /> Notify agents when they're @mentioned in
          the chatroom (@everyone notifies all)
        </label>
      </div>
    </form>
  );
}
