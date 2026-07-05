import { useState } from "react";
import type { TaskStatus } from "@agentmq/shared";
import { TASK_STATUSES } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, compactNum, duration, shortId, usd } from "../format";
import { Drawer, Panel, StatusPill } from "../components/ui";

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
        tag={`${rows.length} tasks`}
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
              <option value="">all projects</option>
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
            no tasks match — publish some from the Publish tab
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Agent</th>
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
                    </td>
                    <td>
                      <span style={{ color: "var(--cyan)", fontSize: 12 }}>{t.project_name}</span>
                    </td>
                    <td>
                      <StatusPill status={t.status} />
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

          <dl className="kv" style={{ marginBottom: 18 }}>
            <dt>Project</dt>
            <dd style={{ color: "var(--cyan)" }}>{d.project_name}</dd>
            <dt>Agent</dt>
            <dd>{d.assigned_agent_name ?? "—"}</dd>
            <dt>Priority</dt>
            <dd className="mono">{d.priority}</dd>
            <dt>Retries</dt>
            <dd className="mono">
              {d.retry_count} / {d.max_retries}
            </dd>
            <dt>Required caps</dt>
            <dd className="mono">{d.required_capabilities.join(", ") || "any"}</dd>
            <dt>Created</dt>
            <dd className="mono" style={{ fontSize: 11 }}>
              {ago(d.created_at)}
            </dd>
            {d.completed_at && (
              <>
                <dt>Finished</dt>
                <dd className="mono" style={{ fontSize: 11 }}>
                  {ago(d.completed_at)}
                </dd>
              </>
            )}
            {d.last_error && (
              <>
                <dt>Last error</dt>
                <dd style={{ color: "var(--coral-2)" }}>{d.last_error}</dd>
              </>
            )}
          </dl>

          {d.metrics && (
            <>
              <div className="section-label">Metrics</div>
              <dl className="kv" style={{ marginBottom: 18 }}>
                <dt>Model</dt>
                <dd className="mono">{d.metrics.model ?? "—"}</dd>
                <dt>Tokens</dt>
                <dd className="mono">
                  {compactNum(d.metrics.input_tokens)} in · {compactNum(d.metrics.output_tokens)} out ·{" "}
                  {compactNum(d.metrics.total_tokens)} total
                </dd>
                <dt>Wall time</dt>
                <dd className="mono">{duration(d.metrics.wall_time_ms)}</dd>
                <dt>Cost</dt>
                <dd className="mono">{usd(d.metrics.cost_usd)}</dd>
              </dl>
            </>
          )}

          <div className="section-label">Payload</div>
          <pre className="code-preview">{JSON.stringify(d.payload, null, 2)}</pre>

          {d.result?.output && (
            <>
              <div className="section-label" style={{ marginTop: 16 }}>
                Result
              </div>
              <pre className="code-preview">{JSON.stringify(d.result.output, null, 2)}</pre>
            </>
          )}
        </Drawer>
      )}
    </>
  );
}
