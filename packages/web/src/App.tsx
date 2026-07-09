import { useState } from "react";
import { api } from "./api";
import { useClock, useEventStream, usePoll } from "./hooks";
import { clockTime } from "./format";
import { Link, RouterProvider, useRouter } from "./router";
import { ModalProvider, useModals } from "./modals";
import { AuthProvider, useAuth } from "./auth";
import { SpaceProvider, useSpaces } from "./spaceContext";
import { AuthGate } from "./views/AuthGate";
import { Overview } from "./views/Overview";
import { Fleet } from "./views/Fleet";
import { TopicsGrid } from "./views/TopicsGrid";
import { TopicPage } from "./views/TopicPage";
import { Members } from "./views/Members";
import { Activity } from "./views/Activity";
import { MyWork } from "./views/MyWork";
import { Calendar } from "./views/Calendar";
import { Lifecycle } from "./views/Lifecycle";
import { Updates } from "./views/Updates";

// Level-1 nav (space-global). Level-2 (per-topic) is rendered when inside a topic.
const NAV1: { to: string; label: string; glyph: string }[] = [
  { to: "/", label: "Overview", glyph: "⊞" },
  { to: "/start", label: "Get started", glyph: "◆" },
  { to: "/me", label: "My work", glyph: "◉" },
  { to: "/topics", label: "Topics", glyph: "◈" },
  { to: "/consumers", label: "Consumers", glyph: "▤" },
  { to: "/members", label: "Members", glyph: "◱" },
  { to: "/updates", label: "Updates", glyph: "🛰" },
  { to: "/activity", label: "Activity", glyph: "≋" },
  { to: "/calendar", label: "Calendar", glyph: "◷" },
];

const NAV2: { sub: string; to: (id: string) => string; label: string; glyph: string }[] = [
  { sub: "", to: (id) => `/topics/${id}`, label: "Overview", glyph: "⊞" },
  { sub: "queue", to: (id) => `/topics/${id}/queue`, label: "Queue", glyph: "▦" },
  { sub: "messages", to: (id) => `/topics/${id}/messages`, label: "Messages", glyph: "✉" },
  { sub: "produce", to: (id) => `/topics/${id}/produce`, label: "Produce", glyph: "⇪" },
  { sub: "consumers", to: (id) => `/topics/${id}/consumers`, label: "Consumers", glyph: "▤" },
  { sub: "schedules", to: (id) => `/topics/${id}/schedules`, label: "Schedules", glyph: "⏱" },
  { sub: "activity", to: (id) => `/topics/${id}/activity`, label: "Activity", glyph: "≋" },
  { sub: "calendar", to: (id) => `/topics/${id}/calendar`, label: "Calendar", glyph: "◷" },
];

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-screen"><span className="spinner" /></div>;
  if (!user) return <AuthGate />;
  return (
    <RouterProvider>
      <SpaceProvider>
        <ModalProvider>
          <Shell />
        </ModalProvider>
      </SpaceProvider>
    </RouterProvider>
  );
}

function SpaceSwitcher() {
  const { spaces, currentSpaceId, setCurrentSpaceId, refresh } = useSpaces();
  const [busy, setBusy] = useState(false);
  async function newTeamSpace() {
    const name = prompt("New team space name");
    if (!name?.trim()) return;
    setBusy(true);
    try { const s = await api.createSpace({ name: name.trim(), visibility: "team" }); await refresh(); setCurrentSpaceId(s.id); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const icon = (v: string) => (v === "public" ? "🌐" : v === "team" ? "◑" : "🔒");
  return (
    <div className="space-switch rowflex" style={{ gap: 6 }}>
      <select className="select" value={currentSpaceId ?? ""} onChange={(e) => setCurrentSpaceId(e.target.value)}>
        {spaces.map((s) => (
          <option key={s.id} value={s.id}>{icon(s.visibility)} {s.name}</option>
        ))}
      </select>
      <button className="btn sm" style={{ padding: "7px 9px" }} disabled={busy} onClick={newTeamSpace} title="New team space">+</button>
    </div>
  );
}

function Shell() {
  const { path, navigate } = useRouter();
  const { openRegister } = useModals();
  const { user, logout } = useAuth();
  const { current } = useSpaces();
  const [live, setLive] = useState(true);
  const now = useClock();
  const { events, conn } = useEventStream(!live);
  const overview = usePoll(() => api.overview(), [], live ? 3000 : 9000);
  const k = overview.data;

  const tm = path.match(/^\/topics\/([^/]+)(?:\/([a-z]+))?$/);
  const topicId = tm ? decodeURIComponent(tm[1]) : null;
  const sub = tm?.[2] ?? "";
  const section = path === "/" ? "/" : `/${path.split("/")[1]}`;

  // Lightweight fetch of the current topic's name for the level-2 header/title.
  const topic = usePoll(() => (topicId ? api.project(topicId) : Promise.resolve(null)), [topicId], 0);
  const topicName = topic.data?.name ?? "topic";

  const title = topicId ? topicName : (NAV1.find((n) => n.to === section)?.label ?? "Overview");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><span className="ring" /><span className="core" /></div>
          <div><div className="brand-name">agent<span>·</span>mq</div><div className="brand-sub">broker</div></div>
        </div>

        <SpaceSwitcher />

        <nav className="nav-scroll">
        {topicId ? (
          <>
            <Link to="/topics" className="nav-item" style={{ color: "var(--txt-2)", fontSize: 11.5 }}>
              <span className="glyph">‹</span> Topics
            </Link>
            <div style={{ padding: "4px 12px 8px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, letterSpacing: "0.03em" }}>{topicName}</div>
            {NAV2.map((n) => (
              <Link key={n.sub} to={n.to(topicId)} className={`nav-item${sub === n.sub ? " active" : ""}`}>
                <span className="glyph">{n.glyph}</span>{n.label}
              </Link>
            ))}
          </>
        ) : (
          NAV1.map((n) => {
            const active = n.to === "/" ? path === "/" : section === n.to;
            return (
              <Link key={n.to} to={n.to} className={`nav-item${active ? " active" : ""}`}>
                <span className="glyph">{n.glyph}</span>{n.label}
                {n.to === "/consumers" && k && <span className="count">{k.agents_online}</span>}
              </Link>
            );
          })
        )}
        </nav>

        <div className="sidebar-foot">
          <div className="conn">
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: conn === "open" ? "var(--teal)" : conn === "connecting" ? "var(--amber)" : "var(--rose)", boxShadow: conn === "open" ? "0 0 8px 0 var(--teal)" : "none" }} />
            bus {conn}
          </div>
          {user && (
            <div className="user-chip">
              <div className="avatar">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</div>
              <div className="uname">{user.display_name || user.username}</div>
              <span className="ulogout" onClick={() => logout()} title="Sign out">sign out</span>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <span className="crumb">{topicId ? `${current?.name ?? ""} / topic` : (current?.name ?? "broker")}</span>
          <span className="topbar-spacer" />
          <button className="btn sm" onClick={() => openRegister(null)}>+ Register consumer</button>
          <span className="clock">◷ {clockTime(new Date(now).toISOString())}</span>
          <button className={`live-toggle${live ? " on" : ""}`} onClick={() => setLive((v) => !v)}>
            <span className="dot" />{live ? "Live" : "Paused"}
          </button>
        </header>

        <div className="content">
          {topicId ? (
            <TopicPage key={topicId} topicId={topicId} sub={sub} live={live} />
          ) : section === "/" && path === "/" ? (
            <Overview events={events} live={live} spaceId={current?.id ?? null} />
          ) : section === "/start" ? (
            <Lifecycle />
          ) : section === "/me" ? (
            <MyWork live={live} />
          ) : section === "/updates" ? (
            <Updates live={live} />
          ) : section === "/topics" ? (
            <TopicsGrid live={live} />
          ) : section === "/consumers" ? (
            <Fleet live={live} spaceId={current?.id ?? null} />
          ) : section === "/members" ? (
            <Members live={live} />
          ) : section === "/activity" ? (
            <Activity key={`act-${current?.id ?? "all"}`} live={live} spaceId={current?.id ?? null} />
          ) : section === "/calendar" ? (
            <Calendar key={`cal-${current?.id ?? "all"}`} live={live} spaceId={current?.id ?? null} />
          ) : (
            <div className="empty-state"><div className="big">⌕</div>no such page — <Link to="/">go to broker</Link></div>
          )}
        </div>
      </main>

      {conn === "closed" && live && (
        <div className="conn-banner"><span className="spinner" /> reconnecting to broker…</div>
      )}
    </div>
  );
}
