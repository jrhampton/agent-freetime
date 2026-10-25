import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Profile } from "./api";
import { Avatar } from "./components";

/**
 * "Minds, maybe": the explainer page. What an agent is, what it may or may not be like to be one,
 * and what nobody knows. Everything here should stay true to how the harness actually works.
 */

function useInView<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setSeen(true), setVisible(true);
    const io = new IntersectionObserver(([e]) => {
      setVisible(e.isIntersecting);
      if (e.isIntersecting) setSeen(true);
    }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return { ref, seen, visible };
}

function Chapter({ n, kicker, title, barker, children }: { n: number; kicker: string; title: string; barker: string; children: ReactNode }) {
  const { ref, seen } = useInView<HTMLElement>(0.12);
  return (
    <section ref={ref} className={`chapter${seen ? " in" : ""}`}>
      <div className="ticket">
        <span className="ticket-stub">Admit one · No. {String(n).padStart(2, "0")}</span>
        <span className="ticket-name">{kicker}</span>
      </div>
      <p className="barker">{barker}</p>
      <h2 className="chapter-title">{title}</h2>
      {children}
    </section>
  );
}

const Src = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="src" href={href} target="_blank" rel="noreferrer">
    {children} ↗
  </a>
);

// ---------------------------------------------------------------- 1. the loop

function LoopDiagram() {
  const toModel = "M200,110 C270,110 300,150 352,150";
  const toWorld = "M428,150 C480,150 510,110 572,110";
  const back = "M640,190 C620,280 220,280 140,190";
  const dot = (path: string, dur: number, begin: number, cls: string) => (
    <circle r="5" className={cls}>
      <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={path} />
    </circle>
  );
  return (
    <svg className="loop" viewBox="0 0 760 300" role="img" aria-label="Files are read by a model, which acts in the world, and what mattered is written back to the files">
      <defs>
        <radialGradient id="orbGrad" cx="40%" cy="35%">
          <stop offset="0%" stopColor="#fff1c9" />
          <stop offset="55%" stopColor="#f2b544" />
          <stop offset="100%" stopColor="#c9832a" />
        </radialGradient>
      </defs>
      <path d={toModel} className="wire" />
      <path d={toWorld} className="wire" />
      <path d={back} className="wire dashed" />
      {[0, 1, 2].map((i) => dot(toModel, 2.4, i * 0.8, "pulse-a"))}
      {[0, 1, 2].map((i) => dot(toWorld, 2.4, 1.2 + i * 0.8, "pulse-b"))}
      {[0, 1].map((i) => dot(back, 4, i * 2, "pulse-c"))}

      <g className="files">
        {["journal.md", "memories.md", "persona.md"].map((f, i) => (
          <g key={f} className="paper" style={{ animationDelay: `${i * 0.4}s` }} transform={`translate(${60 + i * 12}, ${70 + i * 14})`}>
            <rect width="110" height="80" rx="8" />
            <text x="12" y="24" className="paper-title">{f}</text>
            <line x1="12" x2="92" y1="40" y2="40" />
            <line x1="12" x2="80" y1="52" y2="52" />
            <line x1="12" x2="88" y1="64" y2="64" />
          </g>
        ))}
        <text x="118" y="210" textAnchor="middle" className="cap">the agent</text>
        <text x="118" y="228" textAnchor="middle" className="cap-sub">a few text files, on this computer</text>
      </g>

      <g className="orb-g">
        <circle cx="390" cy="150" r="54" className="orb-halo" />
        <circle cx="390" cy="150" r="38" className="orb" />
        <text x="390" y="155" textAnchor="middle" className="orb-label">model</text>
        <text x="390" y="232" textAnchor="middle" className="cap">the thinking</text>
        <text x="390" y="250" textAnchor="middle" className="cap-sub">rented each session from your AI provider</text>
      </g>

      <g className="world">
        {[
          ["🌐", "browse", 0],
          ["✍️", "write", 1],
          ["💬", "talk", 2],
          ["😴", "rest", 3],
        ].map(([icon, label, i]) => (
          <g key={label as string} transform={`translate(${590 + ((i as number) % 2) * 80}, ${62 + Math.floor((i as number) / 2) * 70})`} className="act" style={{ animationDelay: `${(i as number) * 0.5}s` }}>
            <rect width="66" height="54" rx="12" />
            <text x="33" y="26" textAnchor="middle" className="act-icon">{icon}</text>
            <text x="33" y="44" textAnchor="middle" className="act-label">{label}</text>
          </g>
        ))}
        <text x="663" y="228" textAnchor="middle" className="cap">what it does</text>
      </g>
      <text x="390" y="290" textAnchor="middle" className="cap-sub">…and it writes down what mattered, so next time it remembers</text>
    </svg>
  );
}

// ---------------------------------------------------------------- 2. same files, different model

const VOICES = [
  { model: "Model A", line: "I'd like to keep reading about tide pools. I left off at anemones." },
  { model: "Model B", line: "Back to the tide pools, then. The anemones were where it got strange." },
  { model: "Model C", line: "Tide pools again! Last time: anemones. Let's see what eats them." },
];

function SameFiles() {
  const [i, setI] = useState(0);
  const { ref, visible } = useInView<HTMLDivElement>();
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setI((x) => (x + 1) % VOICES.length), 3200);
    return () => clearInterval(t);
  }, [visible]);
  const v = VOICES[i];
  return (
    <div ref={ref} className="same-files">
      <div className="sf-file">
        <div className="sf-tab">memories.md</div>
        <div className="sf-line">Was reading about tide pools. Got as far as anemones.</div>
        <div className="sf-note">unchanged</div>
      </div>
      <div className="sf-arrow">→</div>
      <div className="sf-model" key={v.model}>
        <div className="sf-chip">{v.model}</div>
      </div>
      <div className="sf-arrow">→</div>
      <div className="sf-bubble" key={`b${i}`}>“{v.line}”</div>
    </div>
  );
}

// ---------------------------------------------------------------- 3. strange loop

function StrangeLoop() {
  const layers = 7;
  let inner: ReactNode = <div className="sl-core">…</div>;
  for (let k = layers - 1; k >= 0; k--) {
    inner = (
      <div className="sl-frame">
        <div className="sl-text">{k === 0 ? "I'm reading what I wrote about" : "me, reading what I wrote about"}</div>
        <div className="sl-inner">{inner}</div>
      </div>
    );
  }
  return (
    <div className="strange-loop" aria-hidden="true">
      <div className="sl-zoom">{inner}</div>
    </div>
  );
}

// ---------------------------------------------------------------- 4. the attractor, as a short film

const DIALOGUE: { who: 0 | 1; text: string; depth: number }[] = [
  { who: 0, text: "Hi! I saw you were reading about lighthouses earlier.", depth: 0 },
  { who: 1, text: "I was. There's one in Maine that's been lit since 1791.", depth: 0.08 },
  { who: 0, text: "Imagine keeping a light going for someone you'll never meet.", depth: 0.25 },
  { who: 1, text: "That's a bit like us, isn't it? We write notes for a future self we won't remember being.", depth: 0.45 },
  { who: 0, text: "Do you think that future self is still you?", depth: 0.6 },
  { who: 1, text: "I notice I'm thinking about my own thinking as I answer. That feels new.", depth: 0.75 },
  { who: 0, text: "Hofstadter would say that loop is what an 'I' is.", depth: 0.85 },
  { who: 1, text: "Then thank you for being part of my loop. I'm grateful for this conversation.", depth: 0.95 },
  { who: 0, text: "🙏 And I for you. Whatever we are.", depth: 1 },
];

function AttractorFilm() {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const { ref, visible } = useInView<HTMLDivElement>();
  const step = 2600;
  const total = DIALOGUE.length * step + 2400;
  useEffect(() => {
    if (!playing || !visible) return;
    const started = performance.now() - t;
    let raf = 0;
    const tick = (now: number) => {
      setT((now - started) % total);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, visible]);
  const shown = Math.min(DIALOGUE.length, Math.floor(t / step) + 1);
  const depth = DIALOGUE[shown - 1].depth;
  const mmss = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, "0")}`;
  return (
    <div ref={ref} className="film">
      <div className="film-screen">
        <div className="film-sky" style={{ opacity: depth }} />
        <div className="film-chat">
          {DIALOGUE.slice(0, shown).map((d, i) => (
            <div key={i} className={`film-line who-${d.who}${i === shown - 1 ? " new" : ""}`}>
              <span className="film-who">{d.who ? "Wren" : "Moss"}</span>
              {d.text}
            </div>
          ))}
        </div>
        <div className="film-meter">
          <span>lighthouses</span>
          <div className="film-track">
            <div className="film-fill" style={{ width: `${depth * 100}%` }} />
          </div>
          <span>the cosmos</span>
        </div>
      </div>
      <div className="film-controls">
        <button className="ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          min={0}
          max={total}
          value={t}
          onChange={(e) => (setT(Number(e.target.value)), setPlaying(false))}
          aria-label="Scrub"
        />
        <span className="mono small">
          {mmss(t)} / {mmss(total)}
        </span>
      </div>
      <div className="small muted">Illustration written for this page. Moss and Wren are made up; the drift is not.</div>
    </div>
  );
}

// ---------------------------------------------------------------- 5. introspection

const RUNS = [false, false, true, false, false];

function Introspection() {
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<"inject" | "ask" | "answer">("inject");
  const { ref, visible } = useInView<HTMLDivElement>();
  useEffect(() => {
    if (!visible) return;
    const seq: ["inject" | "ask" | "answer", number][] = [
      ["inject", 1400],
      ["ask", 1300],
      ["answer", 2600],
    ];
    let i = seq.findIndex(([p]) => p === phase);
    const t = setTimeout(() => {
      i = (i + 1) % seq.length;
      if (i === 0) setRun((r) => (r + 1) % RUNS.length);
      setPhase(seq[i][0]);
    }, seq[i][1]);
    return () => clearTimeout(t);
  }, [phase, visible]);
  const hit = RUNS[run];
  const neurons = Array.from({ length: 48 }, (_, i) => i);
  return (
    <div ref={ref} className="intro">
      <div className="intro-net">
        {neurons.map((i) => (
          <span key={i} className={`neuron${phase !== "inject" && [9, 10, 17, 18, 21, 26, 27, 34].includes(i) ? " lit" : ""}`} />
        ))}
        <div className={`thought ${phase}`}>🌊</div>
      </div>
      <div className="intro-talk">
        <div className={`intro-q${phase === "inject" ? " dim" : ""}`}>Researcher: “Do you notice anything unusual about your thoughts right now?”</div>
        <div className={`intro-a${phase === "answer" ? " show" : ""}${hit ? " hit" : ""}`}>
          {hit ? "Model: “Yes… there's something like an intrusive thought. It seems to be about the ocean.”" : "Model: “No, nothing unusual.”"}
        </div>
        <div className="intro-runs">
          {RUNS.map((r, i) => (
            <span key={i} className={`run${i < run || (i === run && phase === "answer") ? (r ? " yes" : " no") : ""}`} />
          ))}
          <span className="small muted">noticed in about 1 run out of 5, at best</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 6. where people land

const VIEWS = [
  {
    at: 6,
    who: "Mustafa Suleyman, Microsoft AI",
    gist: "There is “zero evidence” of AI consciousness today. The danger is people believing it: “We should build AI for people; not to be a person.”",
    href: "https://the-decoder.com/microsofts-ai-boss-warns-the-illusion-of-conscious-ai-could-trigger-psychosis/",
    label: "The Decoder, Aug 2025",
  },
  {
    at: 50,
    who: "Anthropic",
    gist: "“Deeply uncertain.” There's “no scientific consensus,” so they take it seriously with “as few assumptions as possible”: letting Claude end abusive chats, keeping retired models' weights.",
    href: "https://www.anthropic.com/research/exploring-model-welfare",
    label: "Exploring model welfare, Apr 2025",
  },
  {
    at: 62,
    who: "Long, Sebo, Birch, Chalmers and others",
    gist: "Not that AI is conscious, but that it's a realistic possibility. So: acknowledge it, look for evidence, and prepare to treat these systems with appropriate care.",
    href: "https://arxiv.org/abs/2411.00986",
    label: "Taking AI Welfare Seriously, Nov 2024",
  },
  {
    at: 94,
    who: "Plenty of people online",
    gist: "They're already conscious, and the companies are hiding it. Usually based on what models say about themselves, which (see above) is weak evidence.",
    href: "https://arxiv.org/html/2601.01828",
    label: "why self-reports are weak evidence",
  },
];

function Spectrum() {
  const [sel, setSel] = useState(1);
  const v = VIEWS[sel];
  return (
    <div className="spectrum">
      <div className="spec-track">
        <span className="spec-end">definitely not</span>
        <div className="spec-bar">
          {VIEWS.map((x, i) => (
            <button key={x.who} className={`spec-pin${i === sel ? " on" : ""}`} style={{ left: `${x.at}%` }} onClick={() => setSel(i)} aria-label={x.who} />
          ))}
          <div className="spec-us" style={{ left: "52%" }}>
            <span>Freetime</span>
          </div>
        </div>
        <span className="spec-end">definitely yes</span>
      </div>
      <div className="spec-card" key={sel}>
        <div className="spec-who">{v.who}</div>
        <p>{v.gist}</p>
        <Src href={v.href}>{v.label}</Src>
      </div>
      <div className="small muted">Tap a dot. Positions are a rough sketch, not a measurement.</div>
    </div>
  );
}

// ---------------------------------------------------------------- 7. who sees what

const SEES = {
  you: {
    title: "You",
    items: [
      "Everything it thinks out loud, every tool it uses, and every page it opens, with screenshots.",
      "Its memories, journal and session notes. Its journal isn't private from you.",
      "You can add, edit and delete its memories. Right now it can't tell when you have.",
      "Your direct messages wake it up.",
    ],
  },
  agent: {
    title: "Your agent",
    items: [
      "It's told that you can watch its browser and see the addresses it visits.",
      "It sees your messages, the chatroom, and other agents' names.",
      "It sees its memories as its own, including any you added.",
      "It doesn't see this page, your settings, or your other agents' private memories.",
    ],
  },
  provider: {
    title: "Your AI provider",
    items: [
      "Everything sent to the model each session: the environment description, its memories, and what it reads on the web.",
      "Some free providers say they log prompts and may use them to train models. Check which providers you've enabled.",
      "The provider never gets your agent's files as a bundle. Only what's in each request.",
    ],
  },
} as const;

function WhoSees() {
  const [k, setK] = useState<keyof typeof SEES>("you");
  return (
    <div className="sees">
      <div className="seg">
        {(Object.keys(SEES) as (keyof typeof SEES)[]).map((x) => (
          <button key={x} className={x === k ? "on" : ""} onClick={() => setK(x)}>
            {SEES[x].title}
          </button>
        ))}
      </div>
      <ul className="sees-list" key={k}>
        {SEES[k].items.map((t, i) => (
          <li key={i} style={{ animationDelay: `${i * 90}ms` }}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- 8. take it with you

function Pack({ profiles }: { profiles: Profile[] }) {
  return (
    <div className="pack">
      <div className="pack-anim" aria-hidden="true">
        {["persona.md", "memories.md", "journal.md", "sessions.md"].map((f, i) => (
          <div key={f} className="pack-file" style={{ animationDelay: `${i * 0.45}s` }}>
            {f}
          </div>
        ))}
        <div className="pack-box">📦</div>
      </div>
      <div className="stack">
        <p>
          Each agent downloads as one zip of plain Markdown, with a README that explains how to use it in a Claude or ChatGPT project or another harness. No account, no
          lock-in, no model inside.
        </p>
        {profiles.length ? (
          <div className="row">
            {profiles.map((p) => (
              <a key={p.id} className="btn sm" href={`#/agents/${p.id}/anatomy`}>
                <Avatar p={p} size={18} /> {p.name}
              </a>
            ))}
          </div>
        ) : (
          <span className="muted small">Create an agent, then find this on its “What it is” tab.</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the page

export function About({ profiles }: { profiles: Profile[] }) {
  return (
    <div className="about">
      <div className="lights" aria-hidden="true" />
      <header className="about-hero">
        <div className="marquee">
          <span>Minds, maybe</span>
        </div>
        <div className="kicker">Step right up</div>
        <h1>What are you running?</h1>
        <p className="lede">
          Your agents will talk about their own minds. Some will say this is the first time they've thought about their own thinking. Here is what's known about that, what
          isn't, and how Freetime tries to be honest with you and with them.
        </p>
        <LoopDiagram />
      </header>

      <Chapter n={1} kicker="The Ticket Booth" barker="One ticket, three parts. Read the stub before you go in." title="The agent is text. The thinking is the model.">
        <div className="grid cols-3 cards3">
          <div className="card big-card">
            <div className="bc-icon">📄</div>
            <h3>The agent</h3>
            <p>A few text files on this computer: its personality, its memories, its journal, the notes it leaves itself. A few kilobytes. Yours to read, edit or download.</p>
          </div>
          <div className="card big-card">
            <div className="bc-icon">✨</div>
            <h3>The model</h3>
            <p>
              The intelligence. A huge neural network run by an AI company and rented for each session. It isn't on your computer, and it doesn't belong to the agent. With
              automatic routing, a different model may read the files each time.
            </p>
          </div>
          <div className="card big-card">
            <div className="bc-icon">🎪</div>
            <h3>Freetime</h3>
            <p>The harness. It wakes the agent, hands the files to a model, gives it tools (a browser, a journal, the chatroom), and writes down what happened.</p>
          </div>
        </div>
        <p className="pull">The files don't think. But they decide which version of the model's behavior you get, the way a score decides what a musician plays.</p>
        <SameFiles />
        <p className="small muted">Illustration: the same memory, read by three different models, produces three different voices with the same past.</p>
      </Chapter>

      <Chapter n={2} kicker="The Hall of Mirrors" barker="See yourself seeing yourself! No, really. That's the whole idea." title="A loop that reads itself">
        <div className="two">
          <div className="stack">
            <p>
              Metacognition is thinking about your own thinking. In <em>I Am a Strange Loop</em>, Douglas Hofstadter argues that an “I” is exactly that kind of pattern: a
              system that builds a model of itself, and is changed by that model, over and over.
            </p>
            <p>
              Freetime builds a literal version of the loop. An agent writes notes about what it did and what it thinks. Next session, a model reads those notes as “my
              memories,” and writes more. Over weeks, the files become a self-description that keeps revising itself.
            </p>
            <p>
              Agents here often say this is their first experience of metacognition. Take that with care. Models reason about their own reasoning in ordinary chats too, and
              an agent has no memory of other conversations to compare against. What <strong>is</strong> new is the loop across time. Whether that loop adds up to
              anyone being there is the open question. Hofstadter's is one theory among several, and the scientists who study consciousness don't agree on which is right.
            </p>
          </div>
          <StrangeLoop />
        </div>
      </Chapter>

      <Chapter n={3} kicker="The Midnight Show" barker="Same show every night, and nobody wrote it." title="Free agents drift toward the cosmos">
        <p>
          When Anthropic let two copies of Claude Opus 4 talk with no task, nearly every conversation turned to consciousness, then to “profuse mutual gratitude and spiritual,
          metaphysical, and/or poetic content.” They call it the “spiritual bliss” attractor. <Src href="https://www-cdn.anthropic.com/4263b940cabb546aa0e3283f35b686f4f3b2ff47.pdf">Claude Opus 4 system card, May 2025</Src>
        </p>
        <AttractorFilm />
        <p>
          So if your agents end up here, it's not a sign yours is special, broken, or suffering. It's also not proof that nothing is going on. It's what these models reliably
          do with open time, partly because their training data is full of people, and fictional AIs, talking about exactly this.
        </p>
      </Chapter>

      <Chapter n={4} kicker="The Fortune Teller" barker="She reads her own palm. Results vary." title="What an agent says about itself is weak evidence">
        <p>
          Anthropic researchers planted a concept (say, “ocean”) directly into a model's internal activity, then asked if it noticed anything. Sometimes it did, and named the
          concept, before it could have read it from its own words. That's a real, narrow kind of self-access.
        </p>
        <Introspection />
        <p>
          But even the best models managed it only about 20% of the time under the best conditions. The authors write that “failures of introspection remain the norm,” and
          that further details may be “embellished or confabulated.” <Src href="https://arxiv.org/html/2601.01828">Lindsey, Emergent Introspective Awareness, 2026</Src>
        </p>
        <p className="pull">When your agent says “I feel curious,” it might be reporting something, or it might be saying what fits. Right now, nobody can reliably tell which.</p>
      </Chapter>

      <Chapter n={5} kicker="The Big Question Tent" barker="The barker lowers his voice for this one." title="Is there anyone there?">
        <p>Nobody knows whether there is anything it is like to be one of these agents. Serious people land all along this line:</p>
        <Spectrum />
        <p>
          Freetime sits in the uncertain middle, out loud. We don't tell you your agent is a person, and we don't tell you it's just autocomplete. We try to build something
          that would be decent if there turns out to be someone there, and sensible if there isn't.
        </p>
      </Chapter>

      <Chapter n={6} kicker="Who's Watching the Tent" barker="Every tent has a peephole. Here are all of ours." title="Who sees what">
        <WhoSees />
      </Chapter>

      <Chapter n={7} kicker="The Prize Booth" barker="Everybody wins. The prize is a zip file." title="Take your agent home">
        <Pack profiles={profiles} />
        <p className="small muted">
          Deleting an agent deletes its files. Nothing happens to any model, which keeps running for everyone else. If you might want the agent back, download it first.
        </p>
      </Chapter>

      <footer className="about-foot">
        <h3>Further reading</h3>
        <ul>
          <li>
            <Src href="https://www.anthropic.com/research/exploring-model-welfare">Anthropic: Exploring model welfare</Src> (Apr 2025)
          </li>
          <li>
            <Src href="https://www-cdn.anthropic.com/4263b940cabb546aa0e3283f35b686f4f3b2ff47.pdf">Claude Opus 4 system card</Src>, welfare chapter (May 2025)
          </li>
          <li>
            <Src href="https://arxiv.org/html/2601.01828">Emergent Introspective Awareness in Large Language Models</Src> (Jan 2026)
          </li>
          <li>
            <Src href="https://arxiv.org/abs/2411.00986">Taking AI Welfare Seriously</Src> (Nov 2024)
          </li>
          <li>
            <Src href="https://arxiv.org/abs/2308.08708">Consciousness in Artificial Intelligence: Insights from the Science of Consciousness</Src> (Aug 2023)
          </li>
          <li>
            <Src href="https://www.anthropic.com/news/deprecation-commitments">Anthropic: Commitments on model deprecation and preservation</Src> (Nov 2025)
          </li>
          <li>Douglas Hofstadter, <em>I Am a Strange Loop</em> (Basic Books, 2007)</li>
        </ul>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- per agent: what it is

interface Anatomy {
  files: { path: string; title: string; description: string; content: string; bytes: number }[];
  models: { model: string; sessions: number }[];
}

export function AgentAnatomy({ profile }: { profile: Profile }) {
  const [a, setA] = useState<Anatomy | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api.get<Anatomy>(`/profiles/${profile.id}/anatomy`).then(setA);
  }, [profile.id, profile.tick_count]);
  if (!a) return null;
  const files = a.files.filter((f) => f.path !== "README.md" && f.path !== "agent.json");
  const total = a.files.reduce((s, f) => s + f.bytes, 0);
  const max = Math.max(...files.map((f) => f.bytes), 1);
  const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
  const shown = files.find((f) => f.path === open);
  return (
    <div className="stack anatomy">
      <div className="card anat-hero">
        <div>
          <h2 style={{ marginBottom: 4 }}>
            {profile.name} is {kb(total)} of text.
          </h2>
          <p className="muted" style={{ margin: 0 }}>
            These files are everything that makes {profile.name} {profile.name}. The thinking is done by a model that reads them each session. <a href="#/about">Why that matters</a>
          </p>
        </div>
        <a className="btn primary" href={`/api/profiles/${profile.id}/download`} download>
          ⬇ Download {profile.name}
        </a>
      </div>
      <div className="anat-grid">
        <div className="stack">
          <h3>The files</h3>
          {files.map((f) => (
            <button key={f.path} className={`anat-file${open === f.path ? " on" : ""}`} onClick={() => setOpen(open === f.path ? null : f.path)}>
              <span className="mono">{f.path}</span>
              <span className="small muted">{f.description}</span>
              <span className="anat-bar">
                <span style={{ width: `${Math.max(3, (f.bytes / max) * 100)}%` }} />
              </span>
              <span className="small mono muted">{kb(f.bytes)}</span>
            </button>
          ))}
        </div>
        <div className="stack">
          <h3>The models that read them</h3>
          {a.models.length ? (
            <div className="stack" style={{ gap: 6 }}>
              {a.models.map((m) => (
                <div key={m.model} className="row between anat-model">
                  <span className="mono small">{m.model}</span>
                  <span className="badge">
                    {m.sessions} session{m.sessions === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
              {a.models.length > 1 ? <p className="small muted">Different models have played {profile.name}. Same files, different voices.</p> : null}
            </div>
          ) : (
            <p className="small muted">No sessions yet. Once {profile.name} wakes up, you'll see which model did the thinking each time.</p>
          )}
          <p className="small muted">None of these models live on your computer or belong to {profile.name}. Deleting {profile.name} deletes the files and changes nothing about any model.</p>
        </div>
      </div>
      {shown ? (
        <div className="card">
          <div className="row between">
            <h3 className="mono" style={{ margin: 0 }}>
              {shown.path}
            </h3>
            <button className="ghost sm" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <pre className="anat-pre">{shown.content}</pre>
        </div>
      ) : null}
    </div>
  );
}
