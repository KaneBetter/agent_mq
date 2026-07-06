import { useState } from "react";
import { api } from "./api";
import { useClock, useEventStream, usePoll } from "./hooks";
import { clockTime } from "./format";
import { Overview } from "./views/Overview";
import { Fleet } from "./views/Fleet";
import { Projects } from "./views/Projects";
import { Queue } from "./views/Queue";
import { Publish } from "./views/Publish";
import { Activity } from "./views/Activity";
import { Calendar } from "./views/Calendar";
import { RegisterAgentModal } from "./components/RegisterAgentModal";

type ViewId = "overview" | "fleet" | "projects" | "queue" | "publish" | "activity" | "calendar";

const NAV: { id: ViewId; label: string; glyph: string }[] = [
  { id: "overview", label: "Overview", glyph: "⊞" },
  { id: "fleet", label: "Fleet", glyph: "▤" },
  { id: "projects", label: "Projects", glyph: "◈" },
  { id: "queue", label: "Queue", glyph: "▦" },
  { id: "publish", label: "Publish", glyph: "⇪" },
  { id: "activity", label: "Activity", glyph: "≋" },
  { id: "calendar", label: "Calendar", glyph: "◷" },
];

const TITLES: Record<ViewId, { title: string; crumb: string }> = {
  overview: { title: "Overview", crumb: "control-plane / live" },
  fleet: { title: "Fleet", crumb: "data-plane / consumers" },
  projects: { title: "Projects", crumb: "topics / groups / tags" },
  queue: { title: "Queue", crumb: "messages / lease state" },
  publish: { title: "Publish", crumb: "producer / enqueue" },
  activity: { title: "Activity", crumb: "persisted event log" },
  calendar: { title: "Calendar", crumb: "activity / scheduled" },
};

export function App() {
  const [view, setView] = useState<ViewId>("overview");
  const [live, setLive] = useState(true);
  const [focusProject, setFocusProject] = useState("");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerProject, setRegisterProject] = useState<{ id: string; name: string } | null>(null);
  const now = useClock();
  const { events, conn } = useEventStream(!live);

  const overview = usePoll(() => api.overview(), [], live ? 3000 : 9000);
  const k = overview.data;

  function navTo(id: ViewId) {
    setFocusProject("");
    setView(id);
  }
  function openRegister(project: { id: string; name: string } | null) {
    setRegisterProject(project);
    setRegisterOpen(true);
  }
  function focusProjectView(v: "activity" | "calendar", projectId: string) {
    setFocusProject(projectId);
    setView(v);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span className="ring" />
            <span className="core" />
          </div>
          <div>
            <div className="brand-name">
              agent<span>·</span>mq
            </div>
            <div className="brand-sub">dispatch</div>
          </div>
        </div>

        {NAV.map((n) => (
          <div key={n.id} className={`nav-item${view === n.id ? " active" : ""}`} onClick={() => navTo(n.id)}>
            <span className="glyph">{n.glyph}</span>
            {n.label}
            {n.id === "queue" && k && k.tasks_pending > 0 && <span className="count">{k.tasks_pending}</span>}
            {n.id === "fleet" && k && <span className="count">{k.agents_online}</span>}
          </div>
        ))}

        <div className="sidebar-foot">
          <div className="conn">
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: conn === "open" ? "var(--teal)" : conn === "connecting" ? "var(--amber)" : "var(--rose)",
                boxShadow: conn === "open" ? "0 0 8px 0 var(--teal)" : "none",
              }}
            />
            bus {conn}
          </div>
          <div style={{ marginTop: 4 }}>{k ? `${k.tasks_completed} done · ${k.tasks_dead} dead` : "—"}</div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{TITLES[view].title}</h1>
          <span className="crumb">{TITLES[view].crumb}</span>
          <span className="topbar-spacer" />
          <button className="btn sm" onClick={() => openRegister(null)}>
            + Register agent
          </button>
          <span className="clock">◷ {clockTime(new Date(now).toISOString())}</span>
          <button className={`live-toggle${live ? " on" : ""}`} onClick={() => setLive((v) => !v)}>
            <span className="dot" />
            {live ? "Live" : "Paused"}
          </button>
        </header>

        <div className="content">
          {view === "overview" && <Overview events={events} live={live} />}
          {view === "fleet" && <Fleet live={live} />}
          {view === "projects" && (
            <Projects live={live} onRegister={openRegister} onFocusProject={focusProjectView} />
          )}
          {view === "queue" && <Queue live={live} />}
          {view === "publish" && <Publish />}
          {view === "activity" && <Activity key={`act-${focusProject}`} live={live} initialProject={focusProject} />}
          {view === "calendar" && <Calendar key={`cal-${focusProject}`} live={live} initialProject={focusProject} />}
        </div>
      </main>

      {registerOpen && (
        <RegisterAgentModal
          project={registerProject}
          onClose={() => setRegisterOpen(false)}
          onRegistered={() => overview.refetch()}
        />
      )}

      {conn === "closed" && live && (
        <div className="conn-banner">
          <span className="spinner" />
          reconnecting to control plane…
        </div>
      )}
    </div>
  );
}
