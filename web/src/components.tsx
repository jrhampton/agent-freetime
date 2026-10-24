import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, timeAgo, ts, type EventRow, type Memory, type Profile, type WebRequest } from "./api";
import { useLive } from "./live";

export function useProfiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const load = useCallback(() => api.get<Profile[]>("/profiles").then(setProfiles).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);
  useLive((m) => {
    if (m.channel === "status") setProfiles((ps) => ps?.map((p) => (p.id === m.profileId ? { ...p, state: m.payload } : p)) ?? ps);
    if (m.channel === "event" && m.payload.type === "tick_end") load();
  });
  return { profiles, reload: load };
}

export function Avatar({ p, size = 30 }: { p: { name: string; color: string }; size?: number }) {
  return (
    <span className="avatar" style={{ background: p.color, width: size, height: size, fontSize: size * 0.45 }}>
      {p.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = { thinking: "Active", resting: "Resting", stopped: "Stopped", error: "Error, retrying", budget: "Out of budget" };

export function StatusLine({ p }: { p: Profile }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);
  const s = p.state;
  return (
    <span className="row small" title={s.lastError ?? ""}>
      <span className={`dot s-${s.status}`} />
      {STATUS_LABEL[s.status] ?? s.status}
      {s.nextWakeAt && s.status !== "thinking" ? <span className="muted">· wakes {timeAgo(s.nextWakeAt)}</span> : null}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <em className="small" style={{ fontStyle: "normal" }}>{hint}</em> : null}
    </label>
  );
}

function short(v: unknown, n = 200) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function EventItem({ e, profile, showAgent }: { e: EventRow; profile?: Profile; showAgent?: boolean }) {
  const [open, setOpen] = useState(false);
  const d = e.data ?? {};
  let title: ReactNode = e.type;
  let body: string | null = null;
  switch (e.type) {
    case "tick_start":
      title = `Woke up · session ${d.session}`;
      break;
    case "tick_end":
      title = `Rested for ${Math.round(d.rest * 10) / 10} min · ${d.steps} steps · ${(d.tokensIn ?? 0) + (d.tokensOut ?? 0)} tokens · ${d.model ?? ""}`;
      body = d.note;
      break;
    case "thought":
      title = "Thought";
      body = d.content;
      break;
    case "tool_call":
      title = (
        <>
          <b>{d.name}</b> <span className="mono">{short(d.args, 160)}</span>
        </>
      );
      break;
    case "tool_result":
      title = <>↳ {d.name} result</>;
      body = open ? d.output : short(d.output, 300);
      break;
    case "context":
      title = "Context given at wake-up";
      body = open ? `${d.system}\n\n---\n\n${d.context}` : null;
      break;
    case "reflection":
      title = "Reflected";
      body = (d.insights ?? []).map((i: any) => "• " + i.content).join("\n");
      break;
    case "error":
      title = "Error";
      body = d.message;
      break;
    case "status":
      title = d.message;
      break;
  }
  const expandable = e.type === "tool_result" || e.type === "context";
  return (
    <div className={`ev ${e.type}`}>
      <div className="meta">
        {showAgent && profile ? (
          <>
            <Avatar p={profile} size={16} /> <b style={{ color: "var(--text)" }}>{profile.name}</b>
          </>
        ) : null}
        <span>{ts(e.created_at).toLocaleTimeString()}</span>
        {expandable ? (
          <button className="ghost sm" onClick={() => setOpen(!open)}>
            {open ? "less" : "more"}
          </button>
        ) : null}
      </div>
      <div>{title}</div>
      {body ? <pre>{body}</pre> : null}
    </div>
  );
}

/** Live activity feed: all agents, or one. */
export function EventFeed({ profileId, profiles, limit = 150 }: { profileId?: number; profiles: Profile[]; limit?: number }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [more, setMore] = useState(true);
  useEffect(() => {
    api.get<EventRow[]>(`/events?limit=${limit}${profileId ? `&profileId=${profileId}` : ""}`).then((r) => {
      setEvents(r);
      setMore(r.length === limit);
    });
  }, [profileId, limit]);
  useLive((m) => {
    if (m.channel !== "event") return;
    if (profileId && m.profileId !== profileId) return;
    setEvents((es) => [m.payload, ...es].slice(0, 1000));
  });
  const older = () => {
    const last = events[events.length - 1];
    if (!last) return;
    api.get<EventRow[]>(`/events?limit=${limit}&before=${last.id}${profileId ? `&profileId=${profileId}` : ""}`).then((r) => {
      setEvents((es) => [...es, ...r]);
      setMore(r.length === limit);
    });
  };
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const shown = profileId ? events : events.filter((e) => e.type !== "context");
  if (!shown.length) return <div className="empty">Nothing yet. Launch an agent and its activity shows up here.</div>;
  return (
    <div className="feed">
      {shown.map((e) => (
        <EventItem key={e.id} e={e} profile={byId.get(e.profile_id ?? -1)} showAgent={!profileId} />
      ))}
      {more ? (
        <button onClick={older} style={{ alignSelf: "center" }}>
          Load older
        </button>
      ) : null}
    </div>
  );
}

export function MemoryList({ profileId, shared, profiles }: { profileId?: number; shared?: boolean; profiles: Profile[] }) {
  const [rows, setRows] = useState<Memory[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [adding, setAdding] = useState("");
  const [pinNew, setPinNew] = useState(false);
  const base = shared ? "scope=shared" : `profileId=${profileId}`;
  const load = useCallback(() => {
    api.get<Memory[]>(`/memories?${base}${q ? `&q=${encodeURIComponent(q)}` : ""}${kind ? `&kind=${kind}` : ""}`).then(setRows);
  }, [base, q, kind]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useLive((m) => {
    if (m.channel !== "memory") return;
    const r = m.payload as Memory;
    if (shared ? r.scope === "shared" : r.profile_id === profileId) setRows((rs) => [r, ...rs]);
  });
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const update = async (m: Memory, patch: Partial<Memory>) => {
    const r = await api.put<Memory>(`/memories/${m.id}`, patch);
    setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, ...r } : x)));
  };
  const remove = async (m: Memory) => {
    if (!confirm("Delete this memory? The agent won't remember it.")) return;
    await api.del(`/memories/${m.id}`);
    setRows((rs) => rs.filter((x) => x.id !== m.id));
  };
  const add = async () => {
    if (!adding.trim()) return;
    await api.post("/memories", shared ? { scope: "shared", content: adding, pinned: pinNew } : { profileId, content: adding, pinned: pinNew });
    setAdding("");
    if (!shared) load();
  };
  return (
    <div className="stack">
      <div className="row">
        <input placeholder="Search memories…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 160 }}>
          <option value="">All kinds</option>
          {["episode", "fact", "journal", "reflection", "relationship", "note"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <a className="btn" href={`/api/memories/export?${base}`}>
          Export
        </a>
      </div>
      <div className="card stack">
        <textarea
          placeholder={shared ? "Add a memory every agent with shared memory on will know…" : "Plant a memory for this agent (e.g. something about you)…"}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          style={{ minHeight: 50 }}
        />
        <div className="row between">
          <label className="check small">
            <input type="checkbox" checked={pinNew} onChange={(e) => setPinNew(e.target.checked)} /> Core memory (always shown at wake-up)
          </label>
          <button className="primary" onClick={add} disabled={!adding.trim()}>
            Add memory
          </button>
        </div>
      </div>
      {rows.length === 0 ? <div className="empty">No memories yet.</div> : null}
      {rows.map((m) => (
        <MemoryItem key={m.id} m={m} author={byId.get(m.author_id ?? -1)} onUpdate={(p) => update(m, p)} onDelete={() => remove(m)} />
      ))}
    </div>
  );
}

function MemoryItem({ m, author, onUpdate, onDelete }: { m: Memory; author?: Profile; onUpdate: (p: Partial<Memory>) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  return (
    <div className={`mem ${m.pinned ? "pinned" : ""}`}>
      <div className="row between small">
        <div className="row">
          <span className="badge accent">{m.kind}</span>
          {m.pinned ? <span className="badge accent">core</span> : null}
          <span className="muted">#{m.id}</span>
          <span className="muted">{ts(m.created_at).toLocaleString()}</span>
          {m.scope === "shared" ? <span className="muted">by {author?.name ?? m.author_name ?? "operator"}</span> : null}
          <span className="muted">importance {m.importance}</span>
          {m.access_count ? <span className="muted">recalled {m.access_count}×</span> : null}
        </div>
        <div className="row">
          <button className="ghost sm" onClick={() => onUpdate({ pinned: m.pinned ? 0 : 1 })}>
            {m.pinned ? "Unpin" : "Pin"}
          </button>
          <button className="ghost sm" onClick={() => setEditing(!editing)}>
            Edit
          </button>
          <button className="ghost sm danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
      {editing ? (
        <div className="stack" style={{ marginTop: 8 }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button
              className="primary sm"
              onClick={() => {
                onUpdate({ content: text });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button className="sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{m.content}</div>
      )}
    </div>
  );
}

export function WebTable({ profileId, profiles }: { profileId?: number; profiles: Profile[] }) {
  const [rows, setRows] = useState<WebRequest[]>([]);
  const [domain, setDomain] = useState("");
  const [blockedOnly, setBlockedOnly] = useState(false);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (profileId) qs.set("profileId", String(profileId));
    if (domain) qs.set("domain", domain);
    if (blockedOnly) qs.set("blocked", "1");
    api.get<WebRequest[]>(`/web?${qs}`).then(setRows);
  }, [profileId, domain, blockedOnly]);
  useLive((m) => {
    if (m.channel !== "web") return;
    const r = m.payload as WebRequest;
    if (profileId && r.profile_id !== profileId) return;
    if (domain && r.domain !== domain) return;
    if (blockedOnly && !r.blocked) return;
    setRows((rs) => [r, ...rs].slice(0, 1000));
  });
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return (
    <div className="stack">
      <div className="row">
        {domain ? (
          <span className="badge accent">
            {domain}{" "}
            <button className="ghost sm" onClick={() => setDomain("")}>
              ✕
            </button>
          </span>
        ) : null}
        <label className="check small">
          <input type="checkbox" checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)} /> Blocked only
        </label>
      </div>
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              {!profileId ? <th>Agent</th> : null}
              <th>Tool</th>
              <th>URL</th>
              <th>Result</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = byId.get(r.profile_id);
              return (
                <tr key={r.id}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>
                    {ts(r.created_at).toLocaleTimeString()}
                  </td>
                  {!profileId ? <td>{p ? <a href={`#/agents/${p.id}`}>{p.name}</a> : "?"}</td> : null}
                  <td className="small">
                    {r.tool}
                    {r.method !== "GET" ? ` ${r.method}` : ""}
                  </td>
                  <td className="url">
                    <a href="#" onClick={(e) => (e.preventDefault(), setDomain(r.domain))} title="Filter to this domain">
                      {r.url}
                    </a>
                  </td>
                  <td className="small">
                    {r.blocked ? <span className="badge bad">blocked</span> : r.error ? <span className="badge bad">{r.error}</span> : r.status}
                    {r.blocked && r.error ? <div className="muted">{r.error}</div> : null}
                  </td>
                  <td className="small">{r.bytes != null ? `${Math.round(r.bytes / 1024)} KB` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? <div className="empty">No web activity yet.</div> : null}
      </div>
    </div>
  );
}
