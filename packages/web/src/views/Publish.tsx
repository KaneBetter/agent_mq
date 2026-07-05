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

export function Publish() {
  const projects = usePoll(() => api.projects(), [], 0);
  const types = usePoll(() => api.taskTypes(), [], 0);

  const [projectId, setProjectId] = useState("");
  const [type, setType] = useState("");
  const [payload, setPayload] = useState("{\n  \n}");
  const [priority, setPriority] = useState(0);
  const [count, setCount] = useState(1);
  const [caps, setCaps] = useState("");
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

  const preview: PublishTaskRequest = {
    project_id: projectId || "<project>",
    type: type || "<type>",
    payload: payloadValid ? JSON.parse(payload || "{}") : {},
    priority,
    ...(effectiveCaps.length ? { required_capabilities: effectiveCaps } : {}),
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
          ...(effectiveCaps.length ? { required_capabilities: effectiveCaps } : {}),
        });
      }
      setMsg({ ok: true, text: `dispatched ${n} task${n > 1 ? "s" : ""} → queue tail` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid-2">
      <Panel title="Publish task" tag="→ enqueue" bodyStyle={{ padding: 18 }}>
        <form onSubmit={submit}>
          <label className="fld">
            <span>project</span>
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">select project…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="fld">
            <span>task type</span>
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
              style={!payloadValid ? { borderColor: "var(--coral)" } : undefined}
            />
            {!payloadValid && (
              <span className="mono" style={{ color: "var(--coral-2)", fontSize: 10.5 }}>
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
            <span>override required capabilities (optional)</span>
            <input
              className="input"
              placeholder={typeMeta?.required_capabilities.join(", ") || "inherits from type"}
              value={caps}
              onChange={(e) => setCaps(e.target.value)}
            />
          </label>

          <button className="btn primary" disabled={busy || !projectId || !type || !payloadValid}>
            {busy ? "Dispatching…" : count > 1 ? `Dispatch ${count} tasks` : "Dispatch task"}
          </button>
          {msg && (
            <div
              className="mono"
              style={{
                marginTop: 14,
                fontSize: 12,
                color: msg.ok ? "var(--cyan-2)" : "var(--coral-2)",
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
        <Panel title="How it will be claimed" tag="routing" bodyStyle={{ padding: 14 }}>
          <div className="routing-note">
            The task enters the <b>tail of its project queue</b>. It is claimed by the{" "}
            <b>oldest-first (FIFO)</b> rule: the first subscribed machine whose{" "}
            <b>capabilities cover</b> {effectiveCaps.length ? <span className="mono">[{effectiveCaps.join(", ")}]</span> : "its requirements"}{" "}
            and that is <b>under its concurrency limit</b> picks it up.
            <br />
            <br />
            No scoring. No reputation. No priority tiers between machines — the reported
            tokens and timings are <b>display-only</b> and never bias who gets the work.
            Postgres <span className="mono">FOR UPDATE SKIP LOCKED</span> guarantees two
            machines never grab the same task.
          </div>
        </Panel>
      </div>
    </div>
  );
}
