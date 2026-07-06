import { useMemo, useState } from "react";
import type { PublishTaskRequest } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { Panel } from "../components/ui";

const SAMPLE: Record<string, string> = {
  "web.research": '{\n  "query": "postgres SKIP LOCKED queue patterns",\n  "depth": "quick"\n}',
  "summarize.doc": '{\n  "url": "obj://research/report.md",\n  "max_words": 200\n}',
  "draft.article": '{\n  "topic": "why we cut the scoring system",\n  "tone": "plain"\n}',
  "translate.text": '{\n  "text": "the queue is the easy 20%",\n  "to": "zh"\n}',
  "image.generate": '{\n  "prompt": "a mission-control dispatch board at night",\n  "size": "1024x1024"\n}',
  "shell.command": '{\n  "cmd": "echo hello from the agent"\n}',
  echo: '{\n  "hello": "world"\n}',
  sleep: '{\n  "ms": 2500\n}',
};

export function Publish({ fixedProject }: { fixedProject?: { id: string; name: string } } = {}) {
  const projects = usePoll(() => api.projects(), [], 0);
  const types = usePoll(() => api.taskTypes(), [], 0);

  const [projectId, setProjectId] = useState(fixedProject?.id ?? "");
  const [type, setType] = useState("");
  const [payload, setPayload] = useState("{\n  \n}");
  const [priority, setPriority] = useState(0);
  const [count, setCount] = useState(1);
  const [caps, setCaps] = useState("");
  const [tags, setTags] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // default project once loaded
  if (!projectId && projects.data && projects.data.length > 0) {
    setProjectId(projects.data[0].id);
  }

  const payloadValid = useMemo(() => {
    try {
      JSON.parse(payload || "{}");
      return true;
    } catch {
      return false;
    }
  }, [payload]);

  const typeMeta = (types.data ?? []).find((t) => t.type === type);
  const effectiveCaps = caps
    ? caps.split(",").map((s) => s.trim()).filter(Boolean)
    : typeMeta?.required_capabilities ?? [];
  const effectiveTags = tags.split(",").map((s) => s.trim()).filter(Boolean);
  const scheduledIso = scheduledFor ? new Date(scheduledFor).toISOString() : null;
  const isFuture = scheduledIso ? new Date(scheduledIso).getTime() > Date.now() : false;

  const preview: PublishTaskRequest = {
    project_id: projectId || "<project>",
    type: type || "<type>",
    payload: payloadValid ? JSON.parse(payload || "{}") : {},
    priority,
    ...(effectiveTags.length ? { tags: effectiveTags } : {}),
    ...(effectiveCaps.length ? { required_capabilities: effectiveCaps } : {}),
    ...(scheduledIso ? { scheduled_for: scheduledIso } : {}),
  };

  function pickType(v: string) {
    setType(v);
    if (SAMPLE[v]) setPayload(SAMPLE[v]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !type || !payloadValid) return;
    setBusy(true);
    setMsg(null);
    try {
      const body = JSON.parse(payload || "{}");
      const n = Math.max(1, Math.min(200, count));
      for (let i = 0; i < n; i++) {
        await api.publish({
          project_id: projectId,
          type,
          payload: n > 1 ? { ...body, seq: i + 1 } : body,
          priority,
          ...(effectiveTags.length ? { tags: effectiveTags } : {}),
          ...(effectiveCaps.length ? { required_capabilities: effectiveCaps } : {}),
          ...(scheduledIso ? { scheduled_for: scheduledIso } : {}),
        });
      }
      const dest = isFuture ? "scheduled" : "queue tail";
      setMsg({ ok: true, text: `dispatched ${n} task${n > 1 ? "s" : ""} → ${dest}` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid-2">
      <Panel title="Produce message" tag="→ enqueue" bodyStyle={{ padding: 18 }}>
        <form onSubmit={submit}>
          {!fixedProject && (
            <label className="fld">
              <span>topic</span>
              <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">select topic…</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="fld">
            <span>message type</span>
            <select className="select" value={type} onChange={(e) => pickType(e.target.value)}>
              <option value="">select type…</option>
              {(types.data ?? []).map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type}
                  {t.required_capabilities.length ? ` (${t.required_capabilities.join("·")})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="fld">
            <span>payload (json)</span>
            <textarea
              className="textarea"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              spellCheck={false}
              style={!payloadValid ? { borderColor: "var(--rose)" } : undefined}
            />
            {!payloadValid && (
              <span className="mono" style={{ color: "var(--rose-2)", fontSize: 10.5 }}>
                invalid JSON
              </span>
            )}
          </label>

          <div style={{ display: "flex", gap: 12 }}>
            <label className="fld" style={{ flex: 1 }}>
              <span>priority</span>
              <input
                className="input"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
              />
            </label>
            <label className="fld" style={{ flex: 1 }}>
              <span>burst count</span>
              <input
                className="input"
                type="number"
                min={1}
                max={200}
                value={count}
                onChange={(e) => setCount(Number(e.target.value) || 1)}
              />
            </label>
          </div>

          <label className="fld">
            <span>tags (comma-sep, optional)</span>
            <input
              className="input"
              placeholder="urgent, batch-3, experiment"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>

          <label className="fld">
            <span>schedule for (optional — leave blank to run now)</span>
            <input
              className="input"
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
            {scheduledFor && (
              <span className="mono" style={{ fontSize: 10.5, color: isFuture ? "var(--scheduled)" : "var(--rose-2)" }}>
                {isFuture ? "◷ will be claimable only after this time" : "time is in the past — will run immediately"}
              </span>
            )}
          </label>

          <label className="fld">
            <span>override required capabilities (optional)</span>
            <input
              className="input"
              placeholder={typeMeta?.required_capabilities.join(", ") || "inherits from type"}
              value={caps}
              onChange={(e) => setCaps(e.target.value)}
            />
          </label>

          <button className="btn primary" disabled={busy || !projectId || !type || !payloadValid}>
            {busy ? "Producing…" : isFuture ? `Schedule ${count > 1 ? count + " messages" : "message"}` : count > 1 ? `Produce ${count} messages` : "Produce message"}
          </button>
          {msg && (
            <div
              className="mono"
              style={{
                marginTop: 14,
                fontSize: 12,
                color: msg.ok ? "var(--teal-2)" : "var(--rose-2)",
              }}
            >
              {msg.ok ? "✓ " : "✗ "}
              {msg.text}
            </div>
          )}
        </form>
      </Panel>

      <div className="stack">
        <Panel title="Payload preview" tag="what gets enqueued" bodyStyle={{ padding: 14 }}>
          <pre className="code-preview">{JSON.stringify(preview, null, 2)}</pre>
        </Panel>
        <Panel title="How it will be consumed" tag="routing" bodyStyle={{ padding: 14 }}>
          <div className="routing-note">
            The message enters the <b>tail of its topic queue</b>. It is consumed by the{" "}
            <b>priority-then-oldest (FIFO)</b> rule: the first subscribed consumer whose{" "}
            <b>capabilities cover</b> {effectiveCaps.length ? <span className="mono">[{effectiveCaps.join(", ")}]</span> : "its requirements"}{" "}
            and that is <b>under its concurrency limit</b> leases it.
            <br />
            <br />
            No scoring. No reputation. No priority tiers between consumers — the reported
            tokens and timings are <b>display-only</b> and never bias who gets the work.
            Postgres <span className="mono">FOR UPDATE SKIP LOCKED</span> guarantees two
            consumers never grab the same message.
          </div>
        </Panel>
      </div>
    </div>
  );
}
