import { useState } from "react";
import { api } from "./api";
import { useClock, useEventStream, usePoll } from "./hooks";
import { clockTime } from "./format";
import { Link, RouterProvider, useRouter } from "./router";
import { ModalProvider, useModals } from "./modals";
import { Overview } from "./views/Overview";
import { Fleet } from "./views/Fleet";
import { Projects } from "./views/Projects";
import { ProjectDetail } from "./views/ProjectDetail";
import { Queue } from "./views/Queue";
import { Publish } from "./views/Publish";
import { Activity } from "./views/Activity";
import { Calendar } from "./views/Calendar";

// MQ vocabulary: Broker = control plane, Topic = project, Message = task,
// Consumer = agent, Consumer Group = group, Producer/Produce = publish.
const NAV: { to: string; label: string; glyph: string }[] = [
  { to: "/", label: "Broker", glyph: "⊞" },
  { to: "/topics", label: "Topics", glyph: "◈" },
  { to: "/queue", label: "Queue", glyph: "▦" },
  { to: "/produce", label: "Produce", glyph: "⇪" },
  { to: "/consumers", label: "Consumers", glyph: "▤" },
  { to: "/activity", label: "Activity", glyph: "≋" },
  { to: "/calendar", label: "Calendar", glyph: "◷" },
];

const TITLES: Record<string, { title: string; crumb: string }> = {
  "/": { title: "Broker", crumb: "control plane / live" },
  "/topics": { title: "Topics", crumb: "message streams" },
  "/queue": { title: "Queue", crumb: "messages / lease state" },
  "/produce": { title: "Produce", crumb: "producer / enqueue" },
  "/consumers": { title: "Consumers", crumb: "the consumer fleet" },
  "/activity": { title: "Activity", crumb: "persisted event log" },
  "/calendar": { title: "Calendar", crumb: "activity / scheduled" },
};

export function App() {
  return (
    <RouterProvider>
      <ModalProvider>
        <Shell />
      </ModalProvider>
    </RouterProvider>
  );
}

function Shell() {
  const { path } = useRouter();
  const { openRegister } = useModals();
  const [live, setLive] = useState(true);
  const now = useClock();
  const { events, conn } = useEventStream(!live);
  const overview = usePoll(() => api.overview(), [], live ? 3000 : 9000);
  const k = overview.data;

  const topicMatch = path.match(/^\/topics\/([^/]+)$/);
  const topicId = topicMatch ? decodeURIComponent(topicMatch[1]) : null;
  const section = path === "/" ? "/" : `/${path.split("/")[1]}`;
  const meta = topicId ? { title: "Topic", crumb: "stream / drill-in" } : TITLES[section] ?? TITLES["/"];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span className="ring" />
            <span className="core" />
          </div>
          <div>
            <div className="brand-name">agent<span>·</span>mq</div>
            <div className="brand-sub">broker</div>
          </div>
        </div>

        {NAV.map((n) => {
          const active = n.to === "/" ? path === "/" : section === n.to;
          return (
            <Link key={n.to} to={n.to} className={`nav-item${active ? " active" : ""}`}>
              <span className="glyph">{n.glyph}</span>
              {n.label}
              {n.to === "/queue" && k && k.tasks_pending > 0 && <span className="count">{k.tasks_pending}</span>}
              {n.to === "/consumers" && k && <span className="count">{k.agents_online}</span>}
            </Link>
          );
        })}

        <div className="sidebar-foot">
          <div className="conn">
            <span
              style={{
                width: 7, height: 7, borderRadius: "50%",
                background: conn === "open" ? "var(--teal)" : conn === "connecting" ? "var(--amber)" : "var(--rose)",
                boxShadow: conn === "open" ? "0 0 8px 0 var(--teal)" : "none",
              }}
            />
            bus {conn}
          </div>
          <div style={{ marginTop: 4 }}>{k ? `${k.tasks_completed} acked · ${k.tasks_dead} dead` : "—"}</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{meta.title}</h1>
          <span className="crumb">{meta.crumb}</span>
          <span className="topbar-spacer" />
          <button className="btn sm" onClick={() => openRegister(null)}>+ Register consumer</button>
          <span className="clock">◷ {clockTime(new Date(now).toISOString())}</span>
          <button className={`live-toggle${live ? " on" : ""}`} onClick={() => setLive((v) => !v)}>
            <span className="dot" />
            {live ? "Live" : "Paused"}
          </button>
        </header>

        <div className="content">
          {topicId ? (
            <ProjectDetail key={topicId} projectId={topicId} live={live} />
          ) : section === "/" && path === "/" ? (
            <Overview events={events} live={live} />
          ) : section === "/topics" ? (
            <Projects live={live} />
          ) : section === "/queue" ? (
            <Queue live={live} />
          ) : section === "/produce" ? (
            <Publish />
          ) : section === "/consumers" ? (
            <Fleet live={live} />
          ) : section === "/activity" ? (
            <Activity live={live} />
          ) : section === "/calendar" ? (
            <Calendar live={live} />
          ) : (
            <div className="empty-state"><div className="big">⌕</div>no such page — <Link to="/">go to broker</Link></div>
          )}
        </div>
      </main>

      {conn === "closed" && live && (
        <div className="conn-banner">
          <span className="spinner" />
          reconnecting to broker…
        </div>
      )}
    </div>
  );
}
