import type { LiveEvent } from "@agentmq/shared";
import { ago, eventColor, eventVerb, shortId } from "../format";

function renderMsg(e: LiveEvent) {
  const task = e.task_type ? (
    <>
      <b>{e.task_type}</b>
      {e.task_id ? <span className="muted"> #{shortId(e.task_id)}</span> : null}
    </>
  ) : null;
  const agent = e.agent_name ? <b>{e.agent_name}</b> : null;

  switch (e.type) {
    case "task.published":
      return <>{task} published to <span style={{ color: "var(--teal)" }}>{e.project_name}</span></>;
    case "task.claimed":
      return <>{agent} claimed {task}</>;
    case "task.running":
      return <>{agent} is running {task}</>;
    case "task.completed":
      return <>{agent} completed {task}</>;
    case "task.failed":
      return <>{task} failed on {agent}</>;
    case "task.requeued":
      return <>{task} requeued {e.message ? `· ${e.message}` : ""}</>;
    case "task.dead":
      return <>{task} dead-lettered {e.message ? `· ${e.message}` : ""}</>;
    case "task.canceled":
      return <>{task} canceled</>;
    case "agent.registered":
      return <>{agent} registered</>;
    case "agent.online":
      return <>{agent} came online</>;
    case "agent.offline":
      return <>{agent} went offline</>;
    case "reaper.reclaimed":
      return <>reaper reclaimed {task} {e.message ? `· ${e.message}` : ""}</>;
    default:
      return <>{e.message ?? e.type}</>;
  }
}

export function ActivityStream({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="board-empty" style={{ padding: "40px 0" }}>
        waiting for signal…
      </div>
    );
  }
  return (
    <div className="stream">
      {events.map((e, i) => (
        <div className="ev" key={`${e.ts}-${i}`} style={{ ["--ec" as string]: eventColor(e.type) }}>
          <span className="ev-dot" />
          <div className="ev-body">
            <div className="ev-msg">{renderMsg(e)}</div>
            <div className="ev-time">{ago(e.ts)}</div>
          </div>
          <span className="ev-kind">{eventVerb(e.type)}</span>
        </div>
      ))}
    </div>
  );
}
