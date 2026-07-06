import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, compactNum, duration, shortId, usd } from "../format";
import { AgentPill, Bar, Caps, Drawer, Panel, StatusPill } from "../components/ui";

export function Fleet({ live, spaceId }: { live: boolean; spaceId?: string | null }) {
  const { data: allAgents, error } = usePoll(() => api.agents(), [], live ? 2500 : 8000);
  // Lenient: show consumers in this space, plus legacy ones with no space yet (pre-binding).
  const agents = spaceId ? (allAgents ?? []).filter((a) => !a.space_id || a.space_id === spaceId) : allAgents;
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = usePoll(
    () => (openId ? api.agent(openId) : Promise.resolve(null)),
    [openId],
    openId && live ? 2500 : 0
  );
  const schedules = usePoll(
    () => (openId ? api.agentSchedules({ agent_id: openId }) : Promise.resolve([])),
    [openId],
    openId && live ? 3000 : 0
  );

  return (
    <>
      <Panel title="Consumer fleet" tag="registered consumers" bodyStyle={{ padding: 0 }}>
        {error ? (
          <div className="empty-state">
            <div className="big">⚠</div>
            {error}
          </div>
        ) : (agents ?? []).length === 0 ? (
          <div className="empty-state">
            <div className="big">▤</div>
            No consumers yet. Register one — or grab the connect prompt from Broker:
            <div className="code-preview" style={{ marginTop: 14, textAlign: "left" }}>
              pnpm agent-mq register --name mac-01 --owner you --caps shell,gpu --project research{"\n"}
              pnpm agent-mq schedule install --interval 60 --project research{"\n"}
              pnpm agent-mq run
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Consumer</th>
                  <th>Owner</th>
                  <th>Capabilities</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>In-flight</th>
                  <th style={{ textAlign: "right" }}>Done</th>
                  <th style={{ textAlign: "right" }}>Success</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Work time</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {(agents ?? []).map((a) => (
                  <tr key={a.id} className="row-click" onClick={() => setOpenId(a.id)}>
                    <td>
                      <div style={{ fontWeight: 600, color: "var(--txt-0)" }}>{a.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>
                        #{shortId(a.id)}
                      </div>
                    </td>
                    <td className="mono">{a.owner || "—"}</td>
                    <td>
                      <Caps caps={a.capabilities} />
                    </td>
                    <td>
                      <AgentPill status={a.status} />
                    </td>
                    <td className="num">
                      <span style={{ color: a.inflight > 0 ? "var(--amber-2)" : "var(--txt-2)" }}>
                        {a.inflight}
                      </span>
                      <span className="muted"> / {a.max_concurrency}</span>
                      <div style={{ marginTop: 5 }}>
                        <Bar value={a.inflight} max={a.max_concurrency} color="var(--amber)" />
                      </div>
                    </td>
                    <td className="num">{compactNum(a.completed_count)}</td>
                    <td className="num">
                      {a.success_rate == null ? (
                        <span className="muted">—</span>
                      ) : (
                        `${Math.round(a.success_rate * 100)}%`
                      )}
                    </td>
                    <td className="num">{compactNum(a.total_tokens)}</td>
                    <td className="num">{duration(a.total_wall_time_ms)}</td>
                    <td className="num">{usd(a.total_cost_usd)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {ago(a.last_heartbeat_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {openId && detail.data && (
        <Drawer
          title={detail.data.agent.name}
          tag={`#${shortId(detail.data.agent.id)}`}
          onClose={() => setOpenId(null)}
        >
          <dl className="kv" style={{ marginBottom: 20 }}>
            <dt>Owner</dt>
            <dd>{detail.data.agent.owner || "—"}</dd>
            <dt>Status</dt>
            <dd>
              <AgentPill status={detail.data.agent.status} />
            </dd>
            <dt>Capabilities</dt>
            <dd>
              <Caps caps={detail.data.agent.capabilities} />
            </dd>
            <dt>Concurrency</dt>
            <dd className="mono">
              {detail.data.agent.inflight} in-flight / {detail.data.agent.max_concurrency} max
            </dd>
            <dt>Completed</dt>
            <dd className="mono">
              {detail.data.agent.completed_count} ok · {detail.data.agent.failed_count} failed
            </dd>
            <dt>Total tokens</dt>
            <dd className="mono">{compactNum(detail.data.agent.total_tokens)}</dd>
            <dt>Total cost</dt>
            <dd className="mono">{usd(detail.data.agent.total_cost_usd)}</dd>
            <dt>Machine</dt>
            <dd className="mono" style={{ fontSize: 11 }}>
              {Object.keys(detail.data.agent.machine_info ?? {}).length
                ? JSON.stringify(detail.data.agent.machine_info)
                : "—"}
            </dd>
          </dl>

          <div className="section-label">Poll schedules</div>
          {(schedules.data ?? []).length === 0 ? (
            <div className="muted mono" style={{ fontSize: 12, marginBottom: 18 }}>
              none registered — set up with <span style={{ color: "var(--txt-1)" }}>agent-mq schedule install</span>
            </div>
          ) : (
            <div className="tbl-wrap" style={{ marginBottom: 18 }}>
              <table className="tbl">
                <tbody>
                  {(schedules.data ?? []).map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {s.kind === "site_update" ? "🛰 site update" : `⟳ ${s.project_name ?? "project"}`}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        every {s.interval_seconds >= 3600 ? `${Math.round(s.interval_seconds / 3600)}h` : `${Math.round(s.interval_seconds / 60) || 1}m`}
                      </td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--txt-3)" }}>
                        last {s.last_polled_at ? ago(s.last_polled_at) : "never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="section-label">Recent tasks</div>
          {detail.data.recent_tasks.length === 0 ? (
            <div className="muted mono" style={{ fontSize: 12 }}>
              no task history
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {detail.data.recent_tasks.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.type}</td>
                      <td>
                        <StatusPill status={t.status} />
                      </td>
                      <td className="num">{compactNum(t.metrics?.total_tokens ?? 0)} tok</td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {ago(t.completed_at ?? t.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
