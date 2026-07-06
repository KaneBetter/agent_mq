import { useState } from "react";
import type { ActivityRecord, EventType } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago, eventColor, eventVerb, hm, shortId } from "../format";
import { Panel, Tags } from "../components/ui";

const TYPE_OPTIONS: { value: EventType | ""; label: string }[] = [
  { value: "", label: "all events" },
  { value: "task.published", label: "published" },
  { value: "task.scheduled", label: "scheduled" },
  { value: "task.claimed", label: "claimed" },
  { value: "task.completed", label: "completed" },
  { value: "task.failed", label: "failed" },
  { value: "task.dead", label: "dead-lettered" },
  { value: "task.requeued", label: "requeued" },
  { value: "agent.registered", label: "agent registered" },
  { value: "reaper.reclaimed", label: "reaper reclaimed" },
];

function line(e: ActivityRecord) {
  const t = e.task_type ? (
    <>
      <b>{e.task_type}</b>
      {e.task_id ? <span className="muted"> #{shortId(e.task_id)}</span> : null}
    </>
  ) : null;
  const a = e.agent_name ? <b>{e.agent_name}</b> : null;
  const p = e.project_name ? <span style={{ color: "var(--teal-2)" }}>{e.project_name}</span> : null;
  switch (e.type) {
    case "task.published": return <>{t} published to {p}</>;
    case "task.scheduled": return <>{t} scheduled in {p}</>;
    case "task.claimed": return <>{a} claimed {t}</>;
    case "task.running": return <>{a} running {t}</>;
    case "task.completed": return <>{a} completed {t}</>;
    case "task.failed": return <>{t} failed on {a}</>;
    case "task.requeued": return <>{t} requeued {e.message ? `· ${e.message}` : ""}</>;
    case "task.dead": return <>{t} dead-lettered</>;
    case "task.canceled": return <>{t} canceled</>;
    case "agent.registered": return <>{a} registered {p ? <>→ {p}</> : null}</>;
    case "agent.online": return <>{a} online</>;
    case "agent.offline": return <>{a} offline</>;
    case "reaper.reclaimed": return <>reaper reclaimed {t}</>;
    default: return <>{e.message ?? e.type}</>;
  }
}

export function Activity({ live, initialProject, spaceId }: { live: boolean; initialProject?: string; spaceId?: string | null }) {
  const [projectId, setProjectId] = useState(initialProject ?? "");
  const [type, setType] = useState<EventType | "">("");
  const projects = usePoll(() => api.projects(), [], 0);
  const activity = usePoll(
    () => api.activity({ project_id: projectId, type, limit: 300 }),
    [projectId, type],
    live ? 2500 : 9000
  );

  // Scope the topic dropdown + the feed to the current space (topic events + agent events).
  const spaceTopics = spaceId ? (projects.data ?? []).filter((p) => p.space_id === spaceId) : (projects.data ?? []);
  const spaceTopicIds = new Set(spaceTopics.map((p) => p.id));
  const rows = (activity.data ?? []).filter(
    (e) => !spaceId || !e.project_id || spaceTopicIds.has(e.project_id)
  );

  return (
    <Panel
      title="Activity"
      tag="persisted event log"
      right={
        <div className="filters">
          <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">all topics</option>
            {spaceTopics.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as EventType | "")}>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      }
      bodyStyle={{ padding: 0 }}
    >
      {rows.length === 0 ? (
        <div className="empty-state">
          <div className="big">≋</div>
          no activity recorded yet
        </div>
      ) : (
        <div className="stream" style={{ maxHeight: "calc(100vh - 220px)" }}>
          {rows.map((e) => (
            <div className="ev" key={e.id} style={{ ["--ec" as string]: eventColor(e.type) }}>
              <span className="ev-dot" />
              <div className="ev-body">
                <div className="ev-msg">{line(e)}</div>
                <div className="ev-time">
                  {new Date(e.ts).toLocaleDateString("en-CA")} {hm(e.ts)} · {ago(e.ts)}
                  {e.task_tags && e.task_tags.length > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      <Tags tags={e.task_tags} />
                    </span>
                  )}
                </div>
              </div>
              <span className="ev-kind">{eventVerb(e.type)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
