import type { LiveEvent } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { compactNum, usd } from "../format";
import { Kpi, Panel } from "../components/ui";
import { DispatchBoard } from "../components/DispatchBoard";
import { ActivityStream } from "../components/ActivityStream";
import { ConnectAgent } from "../components/ConnectAgent";

export function Overview({
  events,
  live,
  spaceId,
}: {
  events: LiveEvent[];
  live: boolean;
  spaceId?: string | null;
}) {
  const interval = live ? 1500 : 6000;
  const projects = usePoll(() => api.projects(), [], interval);
  const tasksAll = usePoll(() => api.tasks({ limit: 300 }), [], interval);
  const agentsAll = usePoll(() => api.agents(), [], interval);

  // Scope everything to the selected space.
  const spaceTopics = (projects.data ?? []).filter((p) => !spaceId || p.space_id === spaceId);
  const topicIds = new Set(spaceTopics.map((p) => p.id));
  const tasks = (tasksAll.data ?? []).filter((t) => topicIds.has(t.project_id));
  const agents = (agentsAll.data ?? []).filter((a) => !spaceId || a.space_id === spaceId);
  const spaceEvents = events.filter((e) => !e.project_id || topicIds.has(e.project_id));

  const sum = (key: "pending" | "running" | "completed" | "dead") =>
    spaceTopics.reduce((s, p) => s + p[key], 0);
  const k = {
    online: agents.filter((a) => a.status === "online").length,
    total: agents.length,
    queued: sum("pending"),
    running: sum("running"),
    acked: sum("completed"),
    dead: sum("dead"),
    tokens: agents.reduce((s, a) => s + a.total_tokens, 0),
    cost: agents.reduce((s, a) => s + a.total_cost_usd, 0),
  };
  const loaded = projects.data != null;

  return (
    <div className="stack">
      <ConnectAgent />
      <div className="kpi-row">
        <Kpi label="Consumers online" value={loaded ? `${k.online}` : "—"} sub={`of ${k.total} in space`} accent="var(--teal)" />
        <Kpi label="Queued" value={loaded ? compactNum(k.queued) : "—"} sub="awaiting a consumer" accent="var(--pending)" />
        <Kpi label="In-flight" value={loaded ? compactNum(k.running) : "—"} sub="on consumers" accent="var(--running)" />
        <Kpi label="Acked" value={loaded ? compactNum(k.acked) : "—"} sub="all time" accent="var(--completed)" />
        <Kpi label="Dead-letter" value={loaded ? compactNum(k.dead) : "—"} sub="needs attention" accent="var(--dead)" />
        <Kpi label="Tokens · cost" value={loaded ? compactNum(k.tokens) : "—"} sub={usd(k.cost)} accent="var(--amber)" />
      </div>

      <Panel
        title="Message flow"
        tag="QUEUED → IN-FLIGHT → ACKED"
        right={<span className="tag" style={{ color: live ? "var(--amber)" : "var(--txt-3)" }}>{live ? "● LIVE" : "○ PAUSED"}</span>}
        bodyStyle={{ padding: 0 }}
      >
        {tasksAll.error ? (
          <div className="empty-state"><div className="big">⚠</div>can't reach the broker — {tasksAll.error}</div>
        ) : (
          <DispatchBoard tasks={tasks} agents={agents} />
        )}
      </Panel>

      <div className="overview-grid">
        <Panel title="Signal log" tag="this space · live" bodyStyle={{ padding: 0 }}>
          <ActivityStream events={spaceEvents} />
        </Panel>
        <Panel title="Consumer fleet" tag="per consumer" bodyStyle={{ padding: "6px 0" }}>
          <div style={{ maxHeight: 620, overflowY: "auto" }}>
            {agents.length === 0 && <div className="board-empty" style={{ padding: "30px 0" }}>no consumers in this space</div>}
            {agents.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: "1px solid var(--line)" }}>
                <span className="pd" style={{ width: 8, height: 8, borderRadius: "50%", background: a.status === "online" ? "var(--teal)" : "var(--txt-3)", boxShadow: a.status === "online" ? "0 0 8px 0 var(--teal)" : "none", flex: "none" }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.name}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>{a.owner || "—"}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontSize: 12, color: "var(--amber-2)" }}>{a.inflight}/{a.max_concurrency}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>{compactNum(a.total_tokens)} tok</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
