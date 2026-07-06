import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { compactNum } from "../format";
import { useRouter } from "../router";
import { useModals } from "../modals";
import { Panel, Tags } from "../components/ui";
import { ProjectDetail } from "./ProjectDetail";

export function Projects({ live, topicId }: { live: boolean; topicId: string | null }) {
  const { navigate } = useRouter();
  const projects = usePoll(() => api.projects(), [], live ? 3000 : 8000);
  const list = projects.data ?? [];

  return (
    <div className="topics-split">
      <div className="topic-list">
        <div className="section-label" style={{ margin: "2px 0 6px 2px" }}>Topics ({list.length})</div>
        {list.length === 0 && <div className="board-empty" style={{ padding: "20px 0" }}>no topics yet</div>}
        {list.map((p) => (
          <div
            key={p.id}
            className={`topic-item${topicId === p.id ? " active" : ""}`}
            onClick={() => navigate(`/topics/${p.id}`)}
          >
            <div className="ti-name">{p.name}</div>
            {p.tags.length > 0 && <div style={{ marginTop: 5 }}><Tags tags={p.tags} /></div>}
            <div className="ti-stat">
              <span style={{ color: "var(--pending)" }}>{compactNum(p.pending)} queued</span>
              <span style={{ color: "var(--running)" }}>{compactNum(p.running)} in-flight</span>
              <span style={{ color: "var(--teal-2)" }}>{p.eligible_agents} consumer{p.eligible_agents === 1 ? "" : "s"}</span>
            </div>
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 4 }} onClick={() => navigate("/topics")}>
          + New topic
        </button>
      </div>

      <div style={{ minWidth: 0 }}>
        {topicId ? (
          <ProjectDetail key={topicId} projectId={topicId} live={live} />
        ) : (
          <TopicManage onCreated={() => projects.refetch()} />
        )}
      </div>
    </div>
  );
}

function TopicManage({ onCreated }: { onCreated: () => void }) {
  const { openRegister } = useModals();
  const types = usePoll(() => api.taskTypes(), [], 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pTags, setPTags] = useState("");
  const [tType, setTType] = useState("");
  const [tCaps, setTCaps] = useState("");

  async function addTopic(e: React.FormEvent) {
    e.preventDefault();
    if (!pName.trim()) return;
    setBusy(true); setMsg(null);
    try {
      await api.createProject({
        name: pName.trim(),
        description: pDesc.trim(),
        tags: pTags.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setPName(""); setPDesc(""); setPTags("");
      setMsg(`topic "${pName.trim()}" created`);
      onCreated();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function addType(e: React.FormEvent) {
    e.preventDefault();
    if (!tType.trim()) return;
    setBusy(true); setMsg(null);
    try {
      await api.createTaskType({ type: tType.trim(), required_capabilities: tCaps.split(",").map((s) => s.trim()).filter(Boolean) });
      setTType(""); setTCaps("");
      setMsg(`message type "${tType.trim()}" registered`);
      types.refetch();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <Panel title="Manage topics" tag="select a topic on the left, or create one" bodyStyle={{ padding: 20 }}>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
          Pick a topic from the list to drill into its queue, messages, consumers, activity and schedules.
        </div>
        <button className="btn sm" onClick={() => openRegister(null)}>+ Register consumer (global)</button>
      </Panel>

      <div className="grid-2">
        <Panel title="New topic" tag="a message stream" bodyStyle={{ padding: 16 }}>
          <form onSubmit={addTopic}>
            <label className="fld"><span>name</span>
              <input className="input" placeholder="e.g. research" value={pName} onChange={(e) => setPName(e.target.value)} />
            </label>
            <label className="fld"><span>description</span>
              <input className="input" placeholder="what flows through here" value={pDesc} onChange={(e) => setPDesc(e.target.value)} />
            </label>
            <label className="fld"><span>tags (comma-sep)</span>
              <input className="input" placeholder="llm, research, gpu" value={pTags} onChange={(e) => setPTags(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !pName.trim()}>Create topic</button>
          </form>
        </Panel>

        <Panel title="Register message type" tag="keeps types diverse" bodyStyle={{ padding: 16 }}>
          <form onSubmit={addType}>
            <label className="fld"><span>type name</span>
              <input className="input" placeholder="e.g. summarize.doc" value={tType} onChange={(e) => setTType(e.target.value)} />
            </label>
            <label className="fld"><span>required capabilities (comma-sep)</span>
              <input className="input" placeholder="gpu, shell" value={tCaps} onChange={(e) => setTCaps(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !tType.trim()}>Register type</button>
          </form>
          <div className="section-label" style={{ marginTop: 18 }}>Known message types</div>
          <div className="chips">
            {(types.data ?? []).map((t) => (
              <span key={t.type} className="chip" title={t.required_capabilities.join(", ") || "no caps"}>
                {t.type}
                {t.required_capabilities.length > 0 && (
                  <span style={{ color: "var(--teal-2)", marginLeft: 6 }}>{t.required_capabilities.join("·")}</span>
                )}
              </span>
            ))}
          </div>
        </Panel>
      </div>
      {msg && <div className="mono" style={{ fontSize: 11.5, color: "var(--teal-2)" }}>{msg}</div>}
    </div>
  );
}
