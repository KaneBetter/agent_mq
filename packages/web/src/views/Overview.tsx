import type { LiveEvent } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { compactNum, usd } from "../format";
import { Kpi, Panel } from "../components/ui";
import { DispatchBoard } from "../components/DispatchBoard";
import { ActivityStream } from "../components/ActivityStream";
import { ConnectAgent } from "../components/ConnectAgent";

export function Overview({ events, live }: { events: LiveEvent[]; live: boolean }) {
  const interval = live ? 1500 : 6000;
  const kpis = usePoll(() => api.overview(), [], interval);
  const tasks = usePoll(() => api.tasks({ limit: 220 }), [], interval);
  const agents = usePoll(() => api.agents(), [], interval);

  const k = kpis.data;

  return (
    <div className="stack">
      <ConnectAgent />
      <div className="kpi-row">
        <Kpi
          label="Consumers online"
          value={k ? `${k.agents_online}` : "—"}
          sub={k ? `of ${k.agents_total} registered` : ""}
          accent="var(--teal)"
        />
        <Kpi
          label="Queued"
          value={k ? compactNum(k.tasks_pending) : "—"}
          sub="awaiting a consumer"
          accent="var(--pending)"
        />
        <Kpi
          label="In-flight"
          value={k ? compactNum(k.tasks_running) : "—"}
          sub="on consumers"
          accent="var(--running)"
        />
        <Kpi
          label="Acked"
          value={k ? compactNum(k.tasks_completed) : "—"}
          sub="all time"
          accent="var(--completed)"
        />
        <Kpi
          label="Dead-letter"
          value={k ? compactNum(k.tasks_dead) : "—"}
          sub="needs attention"
          accent="var(--dead)"
        />
        <Kpi
          label="Tokens · cost"
          value={k ? compactNum(k.total_tokens) : "—"}
          sub={k ? usd(k.total_cost_usd) : ""}
          accent="var(--amber)"
        />
      </div>

      <Panel
        title="Message flow"
        tag="QUEUED → IN-FLIGHT → ACKED"
        right={
          <span className="tag" style={{ color: live ? "var(--amber)" : "var(--txt-3)" }}>
            {live ? "● LIVE" : "○ PAUSED"}
          </span>
        }
        bodyStyle={{ padding: 0 }}
      >
        {tasks.error ? (
          <div className="empty-state">
            <div className="big">⚠</div>
            can't reach the broker — {tasks.error}
          </div>
        ) : (
          <DispatchBoard tasks={tasks.data ?? []} agents={agents.data ?? []} />
        )}
      </Panel>

      <div className="overview-grid">
        <Panel title="Signal log" tag="live event bus" bodyStyle={{ padding: 0 }}>
          <ActivityStream events={events} />
        </Panel>
        <Panel title="Consumer fleet" tag="per consumer" bodyStyle={{ padding: "6px 0" }}>
          <div style={{ maxHeight: 620, overflowY: "auto" }}>
            {(agents.data ?? []).length === 0 && (
              <div className="board-empty" style={{ padding: "30px 0" }}>
                no consumers registered
              </div>
            )}
            {(agents.data ?? []).map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 16px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span
                  className="pd"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: a.status === "online" ? "var(--teal)" : "var(--txt-3)",
                    boxShadow: a.status === "online" ? "0 0 8px 0 var(--teal)" : "none",
                    flex: "none",
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.name}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>
                    {a.owner || "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="mono" style={{ fontSize: 12, color: "var(--amber-2)" }}>
                    {a.inflight}/{a.max_concurrency}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>
                    {compactNum(a.total_tokens)} tok
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
