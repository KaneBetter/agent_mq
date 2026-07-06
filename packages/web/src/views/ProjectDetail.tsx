import { useState } from "react";
import type { ProjectDetail as PDetail, TaskDetail } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, compactNum, hm, recurrenceLabel, shortId } from "../format";
import { useRouter } from "../router";
import { useModals } from "../modals";
import { AgentPill, Caps, Panel, StatusPill, Tags } from "../components/ui";
import { ActivityStream } from "../components/ActivityStream";

/** Consume order: priority DESC, then created_at ASC (mirrors the claim SQL). */
function consumeOrder(a: TaskDetail, b: TaskDetail): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return +new Date(a.created_at) - +new Date(b.created_at);
}
function isScheduledFuture(t: TaskDetail): boolean {
  return !!t.scheduled_for && new Date(t.scheduled_for).getTime() > Date.now();
}

export function ProjectDetail({ projectId, live }: { projectId: string; live: boolean }) {
  const { navigate } = useRouter();
  const { openRegister, openSchedule } = useModals();
  const { data, error, refetch } = usePoll(() => api.project(projectId), [projectId], live ? 3000 : 9000);
  const queue = usePoll(
    () => api.tasks({ project_id: projectId, status: "PENDING", limit: 200 }),
    [projectId],
    live ? 2500 : 9000
  );
  const activity = usePoll(() => api.activity({ project_id: projectId, limit: 60 }), [projectId], live ? 3000 : 9000);
  const [busy, setBusy] = useState<string | null>(null);

  const p: PDetail | null = data;

  async function toggleSchedule(id: string, enabled: boolean) {
    setBusy(id);
    try { await api.updateSchedule(id, { enabled: !enabled }); refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function removeSchedule(id: string) {
    if (!confirm("Delete this schedule?")) return;
    setBusy(id);
    try { await api.deleteSchedule(id); refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  if (error) return <div className="empty-state"><div className="big">⚠</div>{error}</div>;
  if (!p) return <div className="empty-state"><span className="spinner" /> loading topic…</div>;

  const topicRef = { id: p.id, name: p.name };
  const ordered = (queue.data ?? []).slice().sort(consumeOrder);

  return (
    <div className="stack">
      <div className="rowflex" style={{ flexWrap: "wrap" }}>
        <button className="btn sm ghost" onClick={() => navigate("/topics")}>‹ topics</button>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, letterSpacing: "0.03em" }}>{p.name}</h2>
        <Tags tags={p.tags} />
        <span className="muted mono" style={{ fontSize: 12 }}>{p.description}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn sm" onClick={() => openSchedule(topicRef)}>+ New schedule</button>
          <button className="btn sm primary" onClick={() => openRegister(topicRef)}>+ Register consumer</button>
        </div>
      </div>

      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(5,1fr)", marginBottom: 0 }}>
        {([
          ["Queued", p.pending, "var(--pending)"],
          ["In-flight", p.running, "var(--running)"],
          ["Acked", p.completed, "var(--completed)"],
          ["Dead-letter", p.dead, "var(--dead)"],
          ["Consumers", p.agents.length, "var(--teal)"],
        ] as const).map(([label, val, accent]) => (
          <div key={label} className="kpi" style={{ ["--accent" as string]: accent }}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{compactNum(val)}</div>
          </div>
        ))}
      </div>

      {/* Queue — ordered by priority then time (consume order) */}
      <Panel title="Queue" tag="consume order · priority ↓ then oldest ↑" bodyStyle={{ padding: 0 }}>
        {ordered.length === 0 ? (
          <div className="board-empty" style={{ padding: "24px 0" }}>queue empty — nothing waiting to be consumed</div>
        ) : (
          <div className="tbl-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th><th>Message</th><th style={{ textAlign: "right" }}>Priority</th>
                  <th>Required caps</th><th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {ordered.slice(0, 100).map((t, i) => {
                  const sched = isScheduledFuture(t);
                  const next = i === 0 && !sched;
                  return (
                    <tr key={t.id}>
                      <td className="mono" style={{ color: next ? "var(--amber)" : "var(--txt-3)" }}>{next ? "▶" : i + 1}</td>
                      <td>
                        <div className="mono" style={{ fontSize: 12, color: "var(--txt-0)" }}>
                          {t.type}{t.schedule_id ? <span style={{ color: "var(--scheduled)" }}> ⟳</span> : null}
                          {next && <span style={{ color: "var(--amber)", fontSize: 10, marginLeft: 6 }}>next up</span>}
                        </div>
                        {t.tags.length > 0 && <div style={{ marginTop: 3 }}><Tags tags={t.tags} /></div>}
                      </td>
                      <td className="num">{t.priority}</td>
                      <td><Caps caps={t.required_capabilities} /></td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {sched ? <span style={{ color: "var(--scheduled)" }}>◷ {hm(t.scheduled_for)}</span> : ago(t.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid-2">
        <div className="stack">
          <Panel title="Recurring schedules" tag={`${p.schedules.length}`} bodyStyle={{ padding: 0 }}>
            {p.schedules.length === 0 ? (
              <div className="board-empty" style={{ padding: "24px 0" }}>no schedules — add an on-call roster with “+ New schedule”</div>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Name</th><th>Message</th><th>Recurrence</th><th>Next</th><th style={{ textAlign: "right" }}>Runs</th><th></th></tr></thead>
                  <tbody>
                    {p.schedules.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: s.enabled ? "var(--txt-0)" : "var(--txt-3)" }}>{s.name}</div>
                          {s.shift_hours ? <div className="mono" style={{ fontSize: 10, color: "var(--scheduled)" }}>{s.shift_hours}h shifts</div> : null}
                        </td>
                        <td className="mono">{s.type}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{recurrenceLabel(s.recurrence)}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{s.enabled ? ago(s.next_run_at).replace(" ago", "") : "—"}</td>
                        <td className="num">{s.runs_count}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="rowflex" style={{ gap: 4 }}>
                            <button className="btn sm ghost" disabled={busy === s.id} onClick={() => toggleSchedule(s.id, s.enabled)}>{s.enabled ? "pause" : "resume"}</button>
                            <button className="btn sm ghost danger" disabled={busy === s.id} onClick={() => removeSchedule(s.id)}>del</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Upcoming roster" tag="next occurrences" bodyStyle={{ padding: 0 }}>
            {p.upcoming.length === 0 ? (
              <div className="board-empty" style={{ padding: "20px 0" }}>nothing scheduled ahead</div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {p.upcoming.map((o, i) => (
                  <div key={`${o.schedule_id}-${o.at}-${i}`} className="rowflex" style={{ padding: "8px 16px", borderBottom: "1px solid var(--line)", gap: 10 }}>
                    <span className="mono" style={{ color: "var(--scheduled)", fontSize: 12 }}>◷</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="mono" style={{ fontSize: 12, color: "var(--txt-0)" }}>{o.type} <span className="muted">· {o.schedule_name}</span></div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--txt-2)" }}>{new Date(o.at).toLocaleString()}{o.shift_end ? ` → ${hm(o.shift_end)}` : ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Registered consumers" tag={`${p.agents.length} · poll cadence`} bodyStyle={{ padding: 0 }}>
          {p.agents.length === 0 ? (
            <div className="empty-state" style={{ padding: "30px 16px" }}>
              <div className="big">▤</div>
              no consumers yet — click “+ Register consumer”, or give a teammate the connect prompt from Broker.
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Consumer</th><th>Caps</th><th>Status</th><th style={{ textAlign: "right" }}>In-flight</th><th>Poll</th></tr></thead>
                <tbody>
                  {p.agents.map((a) => {
                    const sched = p.agent_schedules.find((s) => s.agent_id === a.id && s.kind === "project_poll");
                    return (
                      <tr key={a.id}>
                        <td><div style={{ fontWeight: 600 }}>{a.name}</div><div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>{a.owner || "—"}</div></td>
                        <td><Caps caps={a.capabilities} /></td>
                        <td><AgentPill status={a.status} /></td>
                        <td className="num">{a.inflight}/{a.max_concurrency}</td>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {sched ? <>every {Math.round(sched.interval_seconds / 60) || 1}m<br /><span style={{ color: "var(--txt-3)", fontSize: 10 }}>last {sched.last_polled_at ? ago(sched.last_polled_at) : "never"}</span></> : <span className="muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Messages" tag={`recent ${p.recent_tasks.length}`} bodyStyle={{ padding: 0 }}>
          {p.recent_tasks.length === 0 ? (
            <div className="board-empty" style={{ padding: "24px 0" }}>no messages yet</div>
          ) : (
            <div className="tbl-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              <table className="tbl">
                <thead><tr><th>Type</th><th>Status</th><th>Consumer</th><th style={{ textAlign: "right" }}>Tokens</th><th>Age</th></tr></thead>
                <tbody>
                  {p.recent_tasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="mono" style={{ fontSize: 12 }}>{t.type}{t.schedule_id ? <span style={{ color: "var(--scheduled)" }}> ⟳</span> : null}</div>
                        {t.tags.length > 0 && <div style={{ marginTop: 3 }}><Tags tags={t.tags} /></div>}
                      </td>
                      <td><StatusPill status={t.status} /></td>
                      <td className="mono" style={{ fontSize: 11 }}>{t.assigned_agent_name ?? "—"}</td>
                      <td className="num">{compactNum(t.metrics?.total_tokens ?? 0)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{ago(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Activity" tag="this topic" bodyStyle={{ padding: 0 }}>
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            <ActivityStream events={activity.data ?? []} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
