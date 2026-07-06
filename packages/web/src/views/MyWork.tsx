import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, compactNum, duration, usd } from "../format";
import { useRouter } from "../router";
import { useAuth } from "../auth";
import { AgentPill, Caps, Panel, StatusPill, Tags } from "../components/ui";

const spaceIcon = (v: string) => (v === "public" ? "🌐" : v === "team" ? "◑" : "🔒");

export function MyWork({ live }: { live: boolean }) {
  const { navigate } = useRouter();
  const { user } = useAuth();
  const { data, error } = usePoll(() => api.myOverview(), [], live ? 4000 : 0);

  if (error) return <div className="empty-state"><div className="big">⚠</div>{error}</div>;
  if (!data) return <div className="empty-state"><span className="spinner" /> loading…</div>;

  const { spaces, topics, agents, recent_tasks } = data;

  return (
    <div className="stack">
      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <div className="kpi" style={{ ["--accent" as string]: "var(--violet)" }}><div className="kpi-label">My spaces</div><div className="kpi-value">{spaces.length}</div></div>
        <div className="kpi" style={{ ["--accent" as string]: "var(--teal)" }}><div className="kpi-label">My topics</div><div className="kpi-value">{topics.length}</div></div>
        <div className="kpi" style={{ ["--accent" as string]: "var(--amber)" }}><div className="kpi-label">My consumers</div><div className="kpi-value">{agents.length}</div><div className="kpi-sub">{agents.filter((a) => a.status === "online").length} online</div></div>
        <div className="kpi" style={{ ["--accent" as string]: "var(--completed)" }}><div className="kpi-label">Tokens spent</div><div className="kpi-value">{compactNum(agents.reduce((s, a) => s + a.total_tokens, 0))}</div><div className="kpi-sub">{usd(agents.reduce((s, a) => s + a.total_cost_usd, 0))}</div></div>
      </div>

      <div className="grid-2">
        <Panel title="My spaces" tag={`${spaces.length}`} bodyStyle={{ padding: 12 }}>
          <div className="stack" style={{ gap: 8 }}>
            {spaces.length === 0 && <div className="board-empty" style={{ padding: "16px 0" }}>no spaces</div>}
            {spaces.map((s) => (
              <div key={s.id} className="rowflex" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
                <span style={{ fontSize: 15 }}>{spaceIcon(s.visibility)}</span>
                <div><div style={{ fontWeight: 600 }}>{s.name}</div><div className="mono muted" style={{ fontSize: 10.5 }}>{s.visibility} · {s.topic_count} topic{s.topic_count === 1 ? "" : "s"}</div></div>
                <span className="pill" style={{ marginLeft: "auto", ["--pc" as string]: "var(--violet)" }}><span className="pd" />{s.my_role ?? "viewer"}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="My topics" tag={`${topics.length}`} bodyStyle={{ padding: 0 }}>
          {topics.length === 0 ? (
            <div className="board-empty" style={{ padding: "20px 0" }}>no topics in your spaces</div>
          ) : (
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {topics.map((t) => (
                <div key={t.id} className="rowflex row-click" style={{ padding: "9px 16px", borderBottom: "1px solid var(--line)" }} onClick={() => navigate(`/topics/${t.id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{t.name}</div>
                    <div className="mono muted" style={{ fontSize: 10.5 }}>{t.space_name ?? "—"}</div>
                  </div>
                  <div className="rowflex" style={{ marginLeft: "auto", gap: 10 }}>
                    <span className="mono" style={{ color: "var(--pending)", fontSize: 11 }}>{compactNum(t.pending)} queued</span>
                    <span className="mono" style={{ color: "var(--running)", fontSize: 11 }}>{compactNum(t.running)} in-flight</span>
                    <span className="mono" style={{ color: "var(--txt-3)" }}>→</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="My consumers" tag={`${agents.length}`} bodyStyle={{ padding: 0 }}>
        {agents.length === 0 ? (
          <div className="empty-state" style={{ padding: "30px 16px" }}><div className="big">▤</div>you haven't registered any consumers yet — open a topic and “+ Register consumer”.</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Consumer</th><th>Space</th><th>Caps</th><th>Status</th><th style={{ textAlign: "right" }}>Done</th><th style={{ textAlign: "right" }}>Tokens</th><th style={{ textAlign: "right" }}>Work time</th><th>Last seen</th></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id}>
                    <td><div style={{ fontWeight: 600 }}>{a.name}</div><Caps caps={a.capabilities} /></td>
                    <td className="mono" style={{ fontSize: 11 }}>{a.space_name ?? "—"}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{a.inflight}/{a.max_concurrency} in-flight</td>
                    <td><AgentPill status={a.status} /></td>
                    <td className="num">{compactNum(a.completed_count)}</td>
                    <td className="num">{compactNum(a.total_tokens)}</td>
                    <td className="num">{duration(a.total_wall_time_ms)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{ago(a.last_heartbeat_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="What my consumers did" tag={`recent ${recent_tasks.length}`} bodyStyle={{ padding: 0 }}>
        {recent_tasks.length === 0 ? (
          <div className="board-empty" style={{ padding: "24px 0" }}>no work yet</div>
        ) : (
          <div className="tbl-wrap" style={{ maxHeight: 380, overflowY: "auto" }}>
            <table className="tbl">
              <thead><tr><th>Message</th><th>Topic</th><th>Status</th><th>Consumer</th><th style={{ textAlign: "right" }}>Tokens</th><th>When</th></tr></thead>
              <tbody>
                {recent_tasks.map((t) => (
                  <tr key={t.id}>
                    <td><div className="mono" style={{ fontSize: 12 }}>{t.type}</div>{t.tags.length > 0 && <div style={{ marginTop: 3 }}><Tags tags={t.tags} /></div>}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--teal-2)" }}>{t.project_name}</td>
                    <td><StatusPill status={t.status} /></td>
                    <td className="mono" style={{ fontSize: 11 }}>{t.assigned_agent_name ?? "—"}</td>
                    <td className="num">{compactNum(t.metrics?.total_tokens ?? 0)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{ago(t.completed_at ?? t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
