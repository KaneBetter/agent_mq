import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { compactNum } from "../format";
import { useRouter } from "../router";
import { useSpaces } from "../spaceContext";
import { Panel, Tags } from "../components/ui";

export function TopicsGrid({ live }: { live: boolean }) {
  const { navigate } = useRouter();
  const { current } = useSpaces();
  const projects = usePoll(() => api.projects(), [], live ? 3000 : 8000);
  const [creating, setCreating] = useState(false);
  const [pName, setPName] = useState("");
  const [pTags, setPTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Level-1 Topics is scoped to the selected space.
  const list = (projects.data ?? []).filter((p) => !current || p.space_id === current.id);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!pName.trim() || !current) return;
    setBusy(true); setErr(null);
    try {
      await api.createProject({
        name: pName.trim(),
        tags: pTags.split(",").map((s) => s.trim()).filter(Boolean),
        space_id: current.id,
      });
      setPName(""); setPTags(""); setCreating(false);
      projects.refetch();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="rowflex">
        <div className="section-label" style={{ margin: 0 }}>
          Topics in {current?.name ?? "…"} <span style={{ color: "var(--txt-3)" }}>({list.length})</span>
        </div>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setCreating((v) => !v)}>+ New topic</button>
      </div>

      {creating && (
        <Panel bodyStyle={{ padding: 16 }}>
          <form onSubmit={create} className="rowflex" style={{ gap: 10, flexWrap: "wrap" }}>
            <input className="input" style={{ flex: 2, minWidth: 160 }} placeholder="topic name" value={pName} onChange={(e) => setPName(e.target.value)} autoFocus />
            <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="tags (comma-sep)" value={pTags} onChange={(e) => setPTags(e.target.value)} />
            <button className="btn primary" disabled={busy || !pName.trim()}>Create in {current?.name}</button>
          </form>
          {err && <div className="mono" style={{ marginTop: 10, fontSize: 11.5, color: "var(--rose-2)" }}>{err}</div>}
        </Panel>
      )}

      {list.length === 0 ? (
        <div className="empty-state"><div className="big">◈</div>no topics in this space yet — create one, or switch space</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
          {list.map((p) => {
            const total = p.pending + p.running + p.completed + p.dead || 1;
            return (
              <div
                key={p.id}
                onClick={() => navigate(`/topics/${p.id}`)}
                style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-lg)", padding: 16, background: "var(--bg-1)", boxShadow: "var(--shadow-sm)", cursor: "pointer" }}
              >
                <div className="rowflex" style={{ flexWrap: "wrap" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 600, letterSpacing: "0.03em" }}>{p.name}</div>
                  <span style={{ marginLeft: "auto", color: "var(--txt-3)" }} className="mono">→</span>
                </div>
                {p.tags.length > 0 && <div style={{ marginTop: 8 }}><Tags tags={p.tags} /></div>}
                <div style={{ display: "flex", gap: 16, marginTop: 14, flexWrap: "wrap" }}>
                  {([["queued", p.pending, "var(--pending)"], ["in-flight", p.running, "var(--running)"], ["acked", p.completed, "var(--completed)"], ["dead", p.dead, "var(--dead)"]] as const).map(([label, val, color]) => (
                    <div key={label}>
                      <div className="mono" style={{ fontSize: 9.5, color: "var(--txt-2)", textTransform: "uppercase" }}>{label}</div>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 19, fontWeight: 700, color }}>{compactNum(val)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", height: 6, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)", marginTop: 12 }}>
                  <span style={{ width: `${(p.completed / total) * 100}%`, background: "var(--completed)" }} />
                  <span style={{ width: `${(p.running / total) * 100}%`, background: "var(--running)" }} />
                  <span style={{ width: `${(p.pending / total) * 100}%`, background: "var(--pending)" }} />
                  <span style={{ width: `${(p.dead / total) * 100}%`, background: "var(--dead)" }} />
                </div>
                <div className="mono muted" style={{ fontSize: 10.5, marginTop: 10 }}>{p.eligible_agents} eligible consumer{p.eligible_agents === 1 ? "" : "s"}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
