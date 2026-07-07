import { useState } from "react";
import type { AgentSummary, ProjectDetail as PDetail, TaskDetail } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, compactNum, hm, recurrenceLabel, shortId } from "../format";
import { useModals } from "../modals";
import { AgentPill, Caps, Drawer, Modal, Panel, StatusPill, Tags } from "../components/ui";
import { ActivityStream } from "../components/ActivityStream";
import { MessageDetail } from "../components/MessageDetail";
import { Publish } from "./Publish";
import { Calendar } from "./Calendar";

function consumeOrder(a: TaskDetail, b: TaskDetail): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return +new Date(a.created_at) - +new Date(b.created_at);
}
function isScheduledFuture(t: TaskDetail): boolean {
  return !!t.scheduled_for && new Date(t.scheduled_for).getTime() > Date.now();
}

export function TopicPage({ topicId, sub, live }: { topicId: string; sub: string; live: boolean }) {
  const { openRegister, openSchedule } = useModals();
  const { data, error, refetch } = usePoll(() => api.project(topicId), [topicId], live ? 3000 : 9000);
  const tasks = usePoll(() => api.tasks({ project_id: topicId, limit: 250 }), [topicId], live ? 2500 : 9000);
  const activity = usePoll(() => api.activity({ project_id: topicId, limit: 80 }), [topicId], live ? 3000 : 9000);
  const [busy, setBusy] = useState<string | null>(null);
  const [reassign, setReassign] = useState<TaskDetail | null>(null);
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  // Live-poll the opened message so its progress log grows while the agent works.
  const msgDetail = usePoll(
    () => (openMsg ? api.task(openMsg) : Promise.resolve(null)),
    [openMsg],
    openMsg && live ? 2500 : 0
  );

  const p: PDetail | null = data;
  if (error) return <div className="empty-state"><div className="big">⚠</div>{error}</div>;
  if (!p) return <div className="empty-state"><span className="spinner" /> loading topic…</div>;

  const ref = { id: p.id, name: p.name };
  const all = tasks.data ?? [];
  const queue = all.filter((t) => t.status === "PENDING").sort(consumeOrder);
  const inflight = all.filter((t) => t.status === "RUNNING" || t.status === "CLAIMED");

  async function stop(id: string) {
    setBusy(id);
    try { await api.stopTask(id); refetch(); tasks.refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function doReassign(id: string, agentId: string) {
    setBusy(id);
    try { await api.reassignTask(id, agentId); setReassign(null); refetch(); tasks.refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function togglePause(a: AgentSummary) {
    setBusy(a.id);
    try { await api.pauseAgent(a.id, !a.paused); refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }
  async function toggleSubPause(agentId: string, paused: boolean) {
    setBusy(agentId);
    try { await api.pauseSubscription(agentId, topicId, paused); refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  return (
    <div className="stack">
      <div className="rowflex" style={{ flexWrap: "wrap" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, letterSpacing: "0.03em" }}>{p.name}</h2>
        <Tags tags={p.tags} />
        <span className="muted mono" style={{ fontSize: 12 }}>{p.description}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn sm" onClick={() => openSchedule(ref)}>+ Schedule</button>
          <button className="btn sm primary" onClick={() => openRegister(ref)}>+ Register consumer</button>
        </div>
      </div>

      {(sub === "" || sub === "overview") && (
        <>
          <div className="kpi-row" style={{ gridTemplateColumns: "repeat(5,1fr)", marginBottom: 0 }}>
            {([["Queued", p.pending, "var(--pending)"], ["In-flight", p.running, "var(--running)"], ["Acked", p.completed, "var(--completed)"], ["Dead-letter", p.dead, "var(--dead)"], ["Consumers", p.agents.length, "var(--teal)"]] as const).map(([label, val, accent]) => (
              <div key={label} className="kpi" style={{ ["--accent" as string]: accent }}><div className="kpi-label">{label}</div><div className="kpi-value">{compactNum(val)}</div></div>
            ))}
          </div>
          <QueuePanel queue={queue} inflight={inflight} busy={busy} onStop={stop} onReassign={setReassign} compact />
          {p.upcoming.length > 0 && (
            <Panel title="Upcoming roster" tag="next occurrences" bodyStyle={{ padding: 0 }}>
              <div style={{ maxHeight: 240, overflowY: "auto" }}>
                {p.upcoming.slice(0, 10).map((o, i) => (
                  <div key={`${o.schedule_id}-${i}`} className="rowflex" style={{ padding: "8px 16px", borderBottom: "1px solid var(--line)", gap: 10 }}>
                    <span className="mono" style={{ color: "var(--scheduled)" }}>◷</span>
                    <span className="mono" style={{ fontSize: 12 }}>{o.type} <span className="muted">· {o.schedule_name}</span></span>
                    <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>{new Date(o.at).toLocaleString()}{o.shift_end ? ` → ${hm(o.shift_end)}` : ""}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}

      {sub === "queue" && <QueuePanel queue={queue} inflight={inflight} busy={busy} onStop={stop} onReassign={setReassign} />}

      {sub === "messages" && (
        <Panel title="Messages" tag={`${all.length}`} bodyStyle={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Type</th><th>Status</th><th>Consumer</th><th style={{ textAlign: "right" }}>Priority</th><th style={{ textAlign: "right" }}>Tokens</th><th>Age</th><th></th></tr></thead>
              <tbody>
                {all.slice().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)).slice(0, 150).map((t) => {
                  const logLen = Array.isArray((t.state as { log?: unknown[] } | null)?.log) ? (t.state as { log: unknown[] }).log.length : 0;
                  return (
                  <tr key={t.id} className="row-click" onClick={() => setOpenMsg(t.id)}>
                    <td><div className="mono" style={{ fontSize: 12 }}>{t.type}{t.schedule_id ? <span style={{ color: "var(--scheduled)" }}> ⟳</span> : null}{logLen > 0 ? <span style={{ color: "var(--txt-3)", fontSize: 10 }}> · {logLen} report{logLen === 1 ? "" : "s"}</span> : null}</div>{t.tags.length > 0 && <div style={{ marginTop: 3 }}><Tags tags={t.tags} /></div>}</td>
                    <td><StatusPill status={t.status} /></td>
                    <td className="mono" style={{ fontSize: 11 }}>{t.assigned_agent_name ?? "—"}</td>
                    <td className="num">{t.priority}</td>
                    <td className="num">{compactNum(t.metrics?.total_tokens ?? 0)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{ago(t.created_at)}</td>
                    <td onClick={(e) => e.stopPropagation()}>{(t.status === "RUNNING" || t.status === "CLAIMED") && <button className="btn sm ghost danger" disabled={busy === t.id} onClick={() => stop(t.id)}>Stop</button>}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {sub === "produce" && <Publish fixedProject={ref} />}

      {sub === "consumers" && (
        <Panel title="Consumers" tag={`${p.agents.length} · rest / pause`} bodyStyle={{ padding: 0 }}>
          {p.agents.length === 0 ? (
            <div className="empty-state" style={{ padding: "30px 16px" }}><div className="big">▤</div>no consumers subscribed — click “+ Register consumer”.</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Consumer</th><th>Caps</th><th>State</th><th style={{ textAlign: "right" }}>In-flight</th><th>Poll</th><th>Rest / pause</th></tr></thead>
                <tbody>
                  {p.agents.map((a) => {
                    const sched = p.agent_schedules.find((s) => s.agent_id === a.id && s.kind === "project_poll");
                    return (
                      <tr key={a.id}>
                        <td><div style={{ fontWeight: 600 }}>{a.name}</div><div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>{a.owner || "—"}</div></td>
                        <td><Caps caps={a.capabilities} /></td>
                        <td>
                          {a.paused ? <span className="pill DEAD"><span className="pd" />PAUSED</span> : a.resting ? <span className="pill CLAIMED"><span className="pd" />RESTING</span> : <AgentPill status={a.status} />}
                        </td>
                        <td className="num">{a.inflight}/{a.max_concurrency}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{sched ? <>every {Math.round(sched.interval_seconds / 60) || 1}m<br /><span style={{ color: "var(--txt-3)", fontSize: 10 }}>last {sched.last_polled_at ? ago(sched.last_polled_at) : "never"}</span></> : "—"}</td>
                        <td>
                          <div className="rowflex" style={{ gap: 4 }}>
                            <button className="btn sm ghost" disabled={busy === a.id} onClick={() => togglePause(a)}>{a.paused ? "resume" : "pause all"}</button>
                            <button className="btn sm ghost" disabled={busy === a.id} onClick={() => toggleSubPause(a.id, true)} title="pause for this topic">pause here</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {sub === "schedules" && (
        <Panel title="Recurring schedules" tag={`${p.schedules.length}`} right={<button className="btn sm primary" onClick={() => openSchedule(ref)}>+ New</button>} bodyStyle={{ padding: 0 }}>
          {p.schedules.length === 0 ? (
            <div className="board-empty" style={{ padding: "24px 0" }}>no schedules — add an on-call roster with “+ New”</div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Name</th><th>Message</th><th>Recurrence</th><th>Next</th><th style={{ textAlign: "right" }}>Runs</th></tr></thead>
                <tbody>
                  {p.schedules.map((s) => (
                    <tr key={s.id}>
                      <td><div style={{ fontWeight: 600 }}>{s.name}</div>{s.shift_hours ? <div className="mono" style={{ fontSize: 10, color: "var(--scheduled)" }}>{s.shift_hours}h shifts</div> : null}</td>
                      <td className="mono">{s.type}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{recurrenceLabel(s.recurrence)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{s.enabled ? ago(s.next_run_at).replace(" ago", "") : "paused"}</td>
                      <td className="num">{s.runs_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {sub === "activity" && (
        <Panel title="Activity" tag="this topic" bodyStyle={{ padding: 0 }}>
          <div style={{ maxHeight: "calc(100vh - 240px)", overflowY: "auto" }}><ActivityStream events={activity.data ?? []} /></div>
        </Panel>
      )}

      {sub === "calendar" && <Calendar live={live} initialProject={topicId} />}

      {openMsg && msgDetail.data && (
        <Drawer title={msgDetail.data.type} tag={`#${shortId(msgDetail.data.id)}`} onClose={() => setOpenMsg(null)}>
          <MessageDetail task={msgDetail.data} />
        </Drawer>
      )}

      {reassign && (
        <Modal title="Reassign message" tag={reassign.type} onClose={() => setReassign(null)}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
            Release the lease and hand <span className="mono">{reassign.type} #{shortId(reassign.id)}</span> to a specific consumer. It keeps its checkpoint and only that consumer can claim it.
          </div>
          {p.agents.length === 0 ? (
            <div className="muted mono" style={{ fontSize: 12 }}>no subscribed consumers to reassign to</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {p.agents.map((a) => (
                <button key={a.id} className="btn" style={{ justifyContent: "flex-start", textAlign: "left" }} disabled={busy === reassign.id} onClick={() => doReassign(reassign.id, a.id)}>
                  {a.name} <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>{a.capabilities.join(", ") || "any"}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function QueuePanel({ queue, inflight, busy, onStop, onReassign, compact }: {
  queue: TaskDetail[]; inflight: TaskDetail[]; busy: string | null;
  onStop: (id: string) => void; onReassign: (t: TaskDetail) => void; compact?: boolean;
}) {
  return (
    <div className="stack">
      {inflight.length > 0 && (
        <Panel title="In-flight" tag={`${inflight.length} · leased`} bodyStyle={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Message</th><th>Consumer</th><th>Status</th><th>Progress</th><th></th></tr></thead>
              <tbody>
                {inflight.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{t.type} <span className="muted">#{shortId(t.id)}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{t.assigned_agent_name ?? "—"}</td>
                    <td><StatusPill status={t.status} /></td>
                    <td className="mono" style={{ fontSize: 11 }}>{t.progress != null ? `${Math.round(t.progress * 100)}%` : "—"}</td>
                    <td>
                      <div className="rowflex" style={{ gap: 4 }}>
                        <button className="btn sm ghost danger" disabled={busy === t.id} onClick={() => onStop(t.id)}>Stop</button>
                        <button className="btn sm ghost" disabled={busy === t.id} onClick={() => onReassign(t)}>Reassign</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      <Panel title="Queue" tag="consume order · priority ↓ then oldest ↑" bodyStyle={{ padding: 0 }}>
        {queue.length === 0 ? (
          <div className="board-empty" style={{ padding: "24px 0" }}>queue empty</div>
        ) : (
          <div className="tbl-wrap" style={compact ? { maxHeight: 320, overflowY: "auto" } : undefined}>
            <table className="tbl">
              <thead><tr><th style={{ width: 40 }}>#</th><th>Message</th><th style={{ textAlign: "right" }}>Priority</th><th>Required caps</th><th>Waiting</th></tr></thead>
              <tbody>
                {queue.slice(0, 100).map((t, i) => {
                  const sched = isScheduledFuture(t);
                  const next = i === 0 && !sched;
                  return (
                    <tr key={t.id}>
                      <td className="mono" style={{ color: next ? "var(--amber)" : "var(--txt-3)" }}>{next ? "▶" : i + 1}</td>
                      <td><div className="mono" style={{ fontSize: 12 }}>{t.type}{t.schedule_id ? <span style={{ color: "var(--scheduled)" }}> ⟳</span> : null}{next && <span style={{ color: "var(--amber)", fontSize: 10, marginLeft: 6 }}>next up</span>}</div>{t.tags.length > 0 && <div style={{ marginTop: 3 }}><Tags tags={t.tags} /></div>}</td>
                      <td className="num">{t.priority}</td>
                      <td><Caps caps={t.required_capabilities} /></td>
                      <td className="mono" style={{ fontSize: 11 }}>{sched ? <span style={{ color: "var(--scheduled)" }}>◷ {hm(t.scheduled_for)}</span> : ago(t.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
