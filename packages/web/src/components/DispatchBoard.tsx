import type { AgentSummary, TaskDetail } from "@agentmq/shared";
import { ago, shortId } from "../format";

function Signal({ t, running }: { t: TaskDetail; running?: boolean }) {
  return (
    <div
      className={`sig${running ? " running" : ""}`}
      style={{ ["--sig" as string]: `var(--${t.status.toLowerCase()})` }}
      title={`${t.type} · ${t.status}`}
    >
      <div className="sig-top">
        <span className="sig-type">{t.type}</span>
        <span className="sig-id">#{shortId(t.id)}</span>
      </div>
      <div className="sig-meta">
        <span className="sig-proj">{t.project_name}</span>
        <span>·</span>
        <span>{t.retry_count > 0 ? `retry ${t.retry_count}` : ago(t.created_at)}</span>
        {t.assigned_agent_name && !running && <span>· {t.assigned_agent_name}</span>}
      </div>
      {running && (
        <div className="sig-progress">
          <i />
        </div>
      )}
    </div>
  );
}

export function DispatchBoard({
  tasks,
  agents,
}: {
  tasks: TaskDetail[];
  agents: AgentSummary[];
}) {
  const pending = tasks
    .filter((t) => t.status === "PENDING")
    .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
  const active = tasks.filter((t) => t.status === "RUNNING" || t.status === "CLAIMED");
  const recent = tasks
    .filter((t) => t.status === "COMPLETED" || t.status === "FAILED" || t.status === "DEAD")
    .sort((a, b) => +new Date(b.completed_at ?? b.created_at) - +new Date(a.completed_at ?? a.created_at))
    .slice(0, 40);

  // Group active tasks into per-agent lanes.
  const laneMap = new Map<string, TaskDetail[]>();
  for (const t of active) {
    const key = t.assigned_agent_id ?? "unassigned";
    if (!laneMap.has(key)) laneMap.set(key, []);
    laneMap.get(key)!.push(t);
  }
  const agentById = new Map(agents.map((a) => [a.id, a]));

  return (
    <div className="board">
      <div className="board-col">
        <div className="board-col-head">
          <span style={{ color: "var(--pending)" }}>◆</span> Pending queue
          <span className="n">{pending.length}</span>
        </div>
        <div className="board-col-body">
          {pending.length === 0 && <div className="board-empty">queue empty</div>}
          {pending.slice(0, 60).map((t) => (
            <Signal key={t.id} t={t} />
          ))}
        </div>
      </div>

      <div className="board-col">
        <div className="board-col-head">
          <span style={{ color: "var(--running)" }}>▶</span> Running · on machines
          <span className="n">{active.length}</span>
        </div>
        <div className="board-col-body">
          {laneMap.size === 0 && <div className="board-empty">no active dispatch</div>}
          {[...laneMap.entries()].map(([agentId, lane]) => {
            const agent = agentById.get(agentId);
            return (
              <div className="lane" key={agentId}>
                <div className="lane-head">
                  <span style={{ color: "var(--cyan)" }}>▪</span>
                  {agent ? agent.name : "unassigned"}
                  <span className="cap">
                    {lane.length}
                    {agent ? ` / ${agent.max_concurrency}` : ""}
                  </span>
                </div>
                {lane.map((t) => (
                  <Signal key={t.id} t={t} running={t.status === "RUNNING"} />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="board-col">
        <div className="board-col-head">
          <span style={{ color: "var(--completed)" }}>●</span> Recently done
          <span className="n">{recent.length}</span>
        </div>
        <div className="board-col-body">
          {recent.length === 0 && <div className="board-empty">nothing finished yet</div>}
          {recent.map((t) => (
            <Signal key={t.id + t.status} t={t} />
          ))}
        </div>
      </div>
    </div>
  );
}
