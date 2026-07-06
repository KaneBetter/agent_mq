import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { compactNum } from "../format";
import { Panel, Tags } from "../components/ui";

interface ProjectsProps {
  live: boolean;
  onRegister: (project: { id: string; name: string }) => void;
  onFocusProject: (view: "activity" | "calendar", projectId: string) => void;
}

export function Projects({ live, onRegister, onFocusProject }: ProjectsProps) {
  const projects = usePoll(() => api.projects(), [], live ? 3000 : 8000);
  const types = usePoll(() => api.taskTypes(), [], 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // create project
  const [pName, setPName] = useState("");
  const [pDesc, setPDesc] = useState("");
  const [pTags, setPTags] = useState("");
  // create task type
  const [tType, setTType] = useState("");
  const [tCaps, setTCaps] = useState("");

  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    if (!pName.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.createProject({
        name: pName.trim(),
        description: pDesc.trim(),
        tags: pTags.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setPName("");
      setPDesc("");
      setPTags("");
      setMsg(`project "${pName.trim()}" created`);
      projects.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addType(e: React.FormEvent) {
    e.preventDefault();
    if (!tType.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.createTaskType({
        type: tType.trim(),
        required_capabilities: tCaps.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setTType("");
      setTCaps("");
      setMsg(`task type "${tType.trim()}" registered`);
      types.refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const list = projects.data ?? [];

  return (
    <div className="stack">
      <Panel title="Projects" tag="topics · consumer groups" bodyStyle={{ padding: 16 }}>
        {list.length === 0 ? (
          <div className="board-empty" style={{ padding: "26px 0" }}>
            no projects — create one below
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {list.map((p) => {
              const total = p.pending + p.running + p.completed + p.dead || 1;
              return (
                <div
                  key={p.id}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius-lg)",
                    padding: 16,
                    background: "var(--bg-1)",
                    boxShadow: "var(--shadow-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 600, letterSpacing: "0.04em" }}>
                      {p.name}
                    </div>
                    <Tags tags={p.tags} />
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {p.description || "—"}
                    </div>
                    <div style={{ marginLeft: "auto" }} className="mono muted">
                      {p.eligible_agents} eligible agent{p.eligible_agents === 1 ? "" : "s"}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 20, marginTop: 14, flexWrap: "wrap" }}>
                    {(
                      [
                        ["pending", p.pending, "var(--pending)"],
                        ["running", p.running, "var(--running)"],
                        ["completed", p.completed, "var(--completed)"],
                        ["dead", p.dead, "var(--dead)"],
                      ] as const
                    ).map(([label, val, color]) => (
                      <div key={label} style={{ minWidth: 78 }}>
                        <div className="mono" style={{ fontSize: 10, color: "var(--txt-2)", textTransform: "uppercase" }}>
                          {label}
                        </div>
                        <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color }}>
                          {compactNum(val)}
                        </div>
                      </div>
                    ))}
                    <div style={{ flex: 1, minWidth: 160, alignSelf: "flex-end" }}>
                      <div style={{ display: "flex", height: 8, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
                        <span style={{ width: `${(p.completed / total) * 100}%`, background: "var(--completed)" }} />
                        <span style={{ width: `${(p.running / total) * 100}%`, background: "var(--running)" }} />
                        <span style={{ width: `${(p.pending / total) * 100}%`, background: "var(--pending)" }} />
                        <span style={{ width: `${(p.dead / total) * 100}%`, background: "var(--dead)" }} />
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                    {p.groups.map((g) => (
                      <span key={g.id} className="chip">◇ {g.name}</span>
                    ))}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      <button className="btn sm ghost" onClick={() => onFocusProject("activity", p.id)}>
                        Activity
                      </button>
                      <button className="btn sm ghost" onClick={() => onFocusProject("calendar", p.id)}>
                        Calendar
                      </button>
                      <button className="btn sm primary" onClick={() => onRegister({ id: p.id, name: p.name })}>
                        + Register agent
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Register task type" tag="keeps types diverse" bodyStyle={{ padding: 16 }}>
          <form onSubmit={addType}>
            <label className="fld">
              <span>type name</span>
              <input className="input" placeholder="e.g. summarize.doc" value={tType} onChange={(e) => setTType(e.target.value)} />
            </label>
            <label className="fld">
              <span>required capabilities (comma-sep)</span>
              <input className="input" placeholder="gpu, shell" value={tCaps} onChange={(e) => setTCaps(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !tType.trim()}>Register type</button>
          </form>
          <div className="section-label" style={{ marginTop: 18 }}>Known types</div>
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

        <Panel title="New project" tag="a topic" bodyStyle={{ padding: 16 }}>
          <form onSubmit={addProject}>
            <label className="fld">
              <span>name</span>
              <input className="input" placeholder="e.g. research" value={pName} onChange={(e) => setPName(e.target.value)} />
            </label>
            <label className="fld">
              <span>description</span>
              <input className="input" placeholder="what flows through here" value={pDesc} onChange={(e) => setPDesc(e.target.value)} />
            </label>
            <label className="fld">
              <span>tags (comma-sep)</span>
              <input className="input" placeholder="llm, research, gpu" value={pTags} onChange={(e) => setPTags(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !pName.trim()}>Create project</button>
          </form>
          {msg && (
            <div className="mono" style={{ marginTop: 14, fontSize: 11.5, color: "var(--teal-2)" }}>{msg}</div>
          )}
        </Panel>
      </div>
    </div>
  );
}
