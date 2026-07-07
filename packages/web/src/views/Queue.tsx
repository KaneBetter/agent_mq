import { useState } from "react";
import type { TaskStatus } from "@agentmq/shared";
import { TASK_STATUSES } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, compactNum, duration, hm, shortId } from "../format";
import { Drawer, Panel, StatusPill, Tags } from "../components/ui";
import { MessageDetail } from "../components/MessageDetail";

export function Queue({ live }: { live: boolean }) {
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [projectId, setProjectId] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const projects = usePoll(() => api.projects(), [], 0);
  const tasks = usePoll(
    () => api.tasks({ status, project_id: projectId, limit: 200 }),
    [status, projectId],
    live ? 2500 : 8000
  );
  const detail = usePoll(
    () => (openId ? api.task(openId) : Promise.resolve(null)),
    [openId],
    openId && live ? 2500 : 0
  );

  async function doAction(kind: "requeue" | "cancel", id: string) {
    setAction(kind);
    try {
      if (kind === "requeue") await api.requeue(id);
      else await api.cancel(id);
      tasks.refetch();
      if (openId) detail.refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setAction(null);
    }
  }

  const rows = tasks.data ?? [];
  const d = detail.data;

  return (
    <>
      <Panel
        title="Queue"
        tag={`${rows.length} messages`}
        right={
          <div className="filters">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "")}>
              <option value="">all statuses</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">all topics</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        }
        bodyStyle={{ padding: 0 }}
      >
        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="big">▦</div>
            no messages match — produce some from the Produce tab
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Message</th>
                  <th>Topic</th>
                  <th>Status</th>
                  <th>Consumer</th>
                  <th style={{ textAlign: "right" }}>Retries</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Time</th>
                  <th>Age</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="row-click" onClick={() => setOpenId(t.id)}>
                    <td>
                      <div className="mono" style={{ color: "var(--txt-0)", fontSize: 12 }}>
                        {t.type}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>
                        #{shortId(t.id)}
                      </div>
                      {t.tags.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          <Tags tags={t.tags} />
                        </div>
                      )}
                    </td>
                    <td>
                      <span style={{ color: "var(--teal)", fontSize: 12 }}>{t.project_name}</span>
                    </td>
                    <td>
                      <StatusPill status={t.status} />
                      {t.scheduled_for && new Date(t.scheduled_for).getTime() > Date.now() && (
                        <div className="mono" style={{ fontSize: 9.5, color: "var(--scheduled)", marginTop: 3 }}>
                          ◷ {hm(t.scheduled_for)}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {t.assigned_agent_name ?? <span className="muted">—</span>}
                    </td>
                    <td className="num">
                      {t.retry_count > 0 ? (
                        <span style={{ color: "var(--failed)" }}>
                          {t.retry_count}/{t.max_retries}
                        </span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="num">{compactNum(t.metrics?.total_tokens ?? 0)}</td>
                    <td className="num">{duration(t.metrics?.wall_time_ms)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {ago(t.created_at)}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {t.status === "DEAD" || t.status === "FAILED" || t.status === "COMPLETED" ? (
                        <button
                          className="btn sm ghost"
                          disabled={action !== null}
                          onClick={() => doAction("requeue", t.id)}
                        >
                          Requeue
                        </button>
                      ) : (
                        <button
                          className="btn sm ghost danger"
                          disabled={action !== null}
                          onClick={() => doAction("cancel", t.id)}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {openId && d && (
        <Drawer title={d.type} tag={`#${shortId(d.id)}`} onClose={() => setOpenId(null)}>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <StatusPill status={d.status} />
            <button
              className="btn sm ghost"
              disabled={action !== null}
              onClick={() => doAction("requeue", d.id)}
            >
              Requeue
            </button>
            {d.status !== "DEAD" && d.status !== "COMPLETED" && (
              <button
                className="btn sm ghost danger"
                disabled={action !== null}
                onClick={() => doAction("cancel", d.id)}
              >
                Cancel
              </button>
            )}
          </div>

          <MessageDetail task={d} />
        </Drawer>
      )}
    </>
  );
}
