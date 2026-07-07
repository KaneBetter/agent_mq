import type { TaskDetail } from "@agentmq/shared";
import { ago, compactNum, duration, hm, usd } from "../format";
import { StatusPill, Tags } from "./ui";

// The full, expandable view of one message — the website↔agent interaction:
// its content (payload), the agent's live progress log, the result, metrics,
// and lifecycle facts. Reused by the Queue drilldown and the Messages tab.
interface LogEntry {
  t?: string;
  msg: string;
}

/** Pull the agent's progress log out of the checkpoint state (state.log). */
function progressLog(state: Record<string, unknown> | null): LogEntry[] {
  const raw = state && Array.isArray(state.log) ? (state.log as unknown[]) : [];
  return raw.map((entry) => {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      return { t: typeof e.t === "string" ? e.t : undefined, msg: typeof e.msg === "string" ? e.msg : JSON.stringify(e) };
    }
    return { msg: String(entry) };
  });
}

/** Any checkpoint state beyond the log (resume cursors etc.), for the raw view. */
function extraState(state: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!state) return null;
  const rest = Object.fromEntries(Object.entries(state).filter(([k]) => k !== "log"));
  return Object.keys(rest).length ? rest : null;
}

export function MessageDetail({ task }: { task: TaskDetail }) {
  const log = progressLog(task.state);
  const extra = extraState(task.state);
  const pct = task.progress != null ? Math.round(task.progress * 100) : null;

  return (
    <div>
      {pct != null && task.status !== "COMPLETED" && (
        <div className="msg-progress" title={`${pct}%`}>
          <div className="msg-progress-fill" style={{ width: `${pct}%` }} />
          <span className="msg-progress-label">{pct}%</span>
        </div>
      )}

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Status</dt><dd><StatusPill status={task.status} /></dd>
        <dt>Topic</dt><dd style={{ color: "var(--teal)" }}>{task.project_name}</dd>
        <dt>Consumer</dt><dd>{task.assigned_agent_name ?? "—"}</dd>
        <dt>Priority</dt><dd className="mono">{task.priority}</dd>
        <dt>Retries</dt><dd className="mono">{task.retry_count} / {task.max_retries}</dd>
        <dt>Required caps</dt><dd className="mono">{task.required_capabilities.join(", ") || "any"}</dd>
        <dt>Tags</dt><dd>{task.tags.length ? <Tags tags={task.tags} /> : <span className="muted">none</span>}</dd>
        {task.schedule_id && (<><dt>Source</dt><dd className="mono" style={{ color: "var(--scheduled)" }}>⟳ recurring schedule</dd></>)}
        {task.scheduled_for && (<><dt>Scheduled for</dt><dd className="mono" style={{ color: "var(--scheduled)" }}>{new Date(task.scheduled_for).toLocaleString()}</dd></>)}
        <dt>Created</dt><dd className="mono" style={{ fontSize: 11 }}>{ago(task.created_at)}</dd>
        {task.claimed_at && (<><dt>Claimed</dt><dd className="mono" style={{ fontSize: 11 }}>{ago(task.claimed_at)}</dd></>)}
        {task.completed_at && (<><dt>Finished</dt><dd className="mono" style={{ fontSize: 11 }}>{ago(task.completed_at)}</dd></>)}
        {task.lease_expires_at && task.status === "RUNNING" && (<><dt>Lease until</dt><dd className="mono" style={{ fontSize: 11 }}>{hm(task.lease_expires_at)}</dd></>)}
        {task.last_error && (<><dt>Last error</dt><dd style={{ color: "var(--rose-2)" }}>{task.last_error}</dd></>)}
      </dl>

      <div className="section-label">Agent progress ({log.length}) <span style={{ color: "var(--txt-3)", fontWeight: 400 }}>— website ↔ agent</span></div>
      {log.length === 0 ? (
        <div className="muted mono" style={{ fontSize: 12, marginBottom: 16 }}>no progress reported yet</div>
      ) : (
        <ol className="msg-log" style={{ marginBottom: 16 }}>
          {log.map((entry, i) => (
            <li key={i} className="msg-log-item">
              <span className="msg-log-dot" />
              <div className="msg-log-body">
                {entry.t && <span className="mono msg-log-t">{entry.t}</span>}
                <div className="msg-log-msg">{entry.msg}</div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="section-label">Content (payload)</div>
      <pre className="code-preview">{JSON.stringify(task.payload, null, 2)}</pre>

      {task.result?.output != null && (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>Result</div>
          <pre className="code-preview">{JSON.stringify(task.result.output, null, 2)}</pre>
        </>
      )}

      {task.metrics && (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>Metrics</div>
          <dl className="kv">
            <dt>Model</dt><dd className="mono">{task.metrics.model ?? "—"}</dd>
            <dt>Tokens</dt>
            <dd className="mono">{compactNum(task.metrics.input_tokens)} in · {compactNum(task.metrics.output_tokens)} out · {compactNum(task.metrics.total_tokens)} total</dd>
            <dt>Wall time</dt><dd className="mono">{duration(task.metrics.wall_time_ms)}</dd>
            <dt>Cost</dt><dd className="mono">{usd(task.metrics.cost_usd)}</dd>
          </dl>
        </>
      )}

      {extra && (
        <details style={{ marginTop: 16 }}>
          <summary className="section-label" style={{ cursor: "pointer", marginBottom: 8 }}>Checkpoint state (raw)</summary>
          <pre className="code-preview">{JSON.stringify(extra, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
