import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { api } from "./api";
import { startLive } from "./live";
import { useProfiles } from "./components";
import { AgentDetail, AgentEditor, Browsers, Chatroom, Dashboard, Personalities, SettingsPage, SharedMemory, WebMonitor } from "./pages";

function useHash() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const NAV = [
  ["#/", "🎪", "Dashboard"],
  ["#/browsers", "🖥️", "Browsers"],
  ["#/chatroom", "💬", "Chatroom"],
  ["#/web", "🌐", "Web activity"],
  ["#/memory", "🧠", "Shared memory"],
  ["#/personalities", "🎭", "Personalities"],
  ["#/settings", "⚙️", "Settings"],
] as const;

function Shell() {
  const hash = useHash();
  const { profiles, reload } = useProfiles();
  useEffect(() => {
    startLive();
  }, []);
  const parts = hash.replace(/^#\/?/, "").split("/");
  let page;
  if (!profiles) page = null;
  else if (parts[0] === "agents" && parts[1] === "new")
    page = (
      <div>
        <h1>New agent</h1>
        <p className="muted">
          Only a name is required. When launched, the agent gets no task: just the environment, its profile, and its memories.
        </p>
        <AgentEditor
          onSaved={(p) => {
            reload();
            location.hash = `#/agents/${p.id}`;
          }}
        />
      </div>
    );
  else if (parts[0] === "agents") {
    const p = profiles.find((x) => x.id === Number(parts[1]));
    page = p ? <AgentDetail key={p.id} profile={p} profiles={profiles} tab={parts[2] ?? "activity"} reload={reload} /> : <div className="empty">Agent not found.</div>;
  } else if (parts[0] === "chatroom") page = <Chatroom profiles={profiles} />;
  else if (parts[0] === "browsers") page = <Browsers profiles={profiles} />;
  else if (parts[0] === "web") page = <WebMonitor profiles={profiles} />;
  else if (parts[0] === "memory") page = <SharedMemory profiles={profiles} />;
  else if (parts[0] === "personalities") page = <Personalities />;
  else if (parts[0] === "settings") page = <SettingsPage />;
  else page = <Dashboard profiles={profiles} />;

  const active = (h: string) => (h === "#/" ? hash === "#/" || hash === "" : hash.startsWith(h));
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">🎪 Agent Free Time</div>
        <nav className="nav stack" style={{ gap: 2 }}>
          {NAV.map(([h, icon, label]) => (
            <a key={h} href={h} className={active(h) ? "active" : ""}>
              <span>{icon}</span> {label}
            </a>
          ))}
        </nav>
        {profiles?.length ? (
          <nav className="nav stack" style={{ gap: 2, marginTop: 14 }}>
            <div className="small muted" style={{ padding: "0 10px" }}>
              Agents
            </div>
            {profiles.map((p) => (
              <a key={p.id} href={`#/agents/${p.id}`} className={hash.startsWith(`#/agents/${p.id}`) ? "active" : ""}>
                <span className={`dot s-${p.state.status}`} /> {p.name}
              </a>
            ))}
          </nav>
        ) : null}
        <div className="spacer" />
        <a className="small muted" href="#" style={{ padding: "0 10px" }} onClick={async (e) => (e.preventDefault(), await api.post("/logout"), location.reload())}>
          Log out
        </a>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/login", { password: pw });
      onDone();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <form className="card login form" onSubmit={submit}>
      <h1>🎪 Agent Free Time</h1>
      <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      {err ? <div className="badge bad">{err}</div> : null}
      <button className="primary" type="submit">
        Log in
      </button>
    </form>
  );
}

function App() {
  const [auth, setAuth] = useState<{ required: boolean; authed: boolean } | null>(null);
  const check = () => api.get<{ required: boolean; authed: boolean }>("/auth").then(setAuth);
  useEffect(() => {
    check();
    const on = () => setAuth({ required: true, authed: false });
    window.addEventListener("auth-required", on);
    return () => window.removeEventListener("auth-required", on);
  }, []);
  if (!auth) return null;
  if (!auth.authed) return <Login onDone={check} />;
  return <Shell />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
