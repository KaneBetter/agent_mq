import { useState } from "react";
import type { SpaceRole } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago } from "../format";
import { useSpaces } from "../spaceContext";
import { Panel } from "../components/ui";

const ROLES: SpaceRole[] = ["admin", "member", "viewer"];

export function Members({ live }: { live: boolean }) {
  const { current, refresh } = useSpaces();
  const spaceId = current?.id ?? null;
  const detail = usePoll(() => (spaceId ? api.space(spaceId) : Promise.resolve(null)), [spaceId], live ? 5000 : 0);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<SpaceRole>("member");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  // my_role is the viewer's effective role (owner is surfaced as "admin"); the
  // space's owner_id column is NOT the viewer's identity, so don't test it here.
  const isManager = current?.my_role === "admin";
  const requests = usePoll(
    () => (spaceId && isManager ? api.spaceJoinRequests(spaceId, "pending") : Promise.resolve([])),
    [spaceId, isManager],
    live ? 6000 : 0
  );

  const d = detail.data;
  const canManage = isManager; // server enforces; UI hint
  const isMember = current?.my_role != null;

  if (!current) return <div className="empty-state">select a space</div>;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!spaceId || !username.trim()) return;
    setBusy(true); setMsg(null);
    try { await api.addMember(spaceId, { username: username.trim(), role }); setUsername(""); setMsg(`added ${username.trim()}`); detail.refetch(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function remove(userId: string) {
    if (!spaceId || !confirm("Remove this member?")) return;
    try { await api.removeMember(spaceId, userId); detail.refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  async function changeRole(userId: string, r: string) {
    if (!spaceId) return;
    try { await api.setMemberRole(spaceId, userId, r); detail.refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  async function setVisibility(v: string) {
    if (!spaceId) return;
    try { await api.updateSpace(spaceId, { visibility: v as "private" | "team" | "public" }); refresh(); detail.refetch(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  async function apply() {
    if (!spaceId) return;
    setBusy(true); setMsg(null);
    try { await api.applyToSpace(spaceId, {}); setApplied(true); setMsg("request submitted — waiting for an admin"); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function decide(requestId: string, decision: "approved" | "denied") {
    if (!spaceId) return;
    try { await api.decideJoinRequest(spaceId, requestId, { decision }); requests.refetch(); detail.refetch(); refresh(); }
    catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="stack">
      <Panel title={current.name} tag={`space · ${current.visibility}`} bodyStyle={{ padding: 16 }}>
        <div className="rowflex" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="mono muted" style={{ fontSize: 12 }}>
            owner {current.owner_username ?? "—"} · your role {current.my_role ?? "viewer"} · {current.member_count} member{current.member_count === 1 ? "" : "s"} · {current.topic_count} topic{current.topic_count === 1 ? "" : "s"}
          </div>
          {current.visibility === "team" && (
            <label className="rowflex" style={{ marginLeft: "auto", gap: 8, fontSize: 12 }}>
              <span className="mono muted">visibility</span>
              <select className="select" style={{ width: "auto" }} value={current.visibility} onChange={(e) => setVisibility(e.target.value)}>
                <option value="team">team</option>
                <option value="private">private</option>
              </select>
            </label>
          )}
        </div>
      </Panel>

      {!isMember && current.visibility !== "private" && (
        <Panel title="Join this space" tag="apply for membership" bodyStyle={{ padding: 16 }}>
          <div className="rowflex" style={{ gap: 12, flexWrap: "wrap" }}>
            <div className="muted" style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
              You're not a member yet. Applying asks an admin to let you in — it installs no schedule.
            </div>
            <button className="btn primary" disabled={busy || applied} onClick={apply}>
              {applied ? "✓ request submitted" : "Apply to join"}
            </button>
          </div>
          {msg && <div className="mono" style={{ marginTop: 12, fontSize: 11.5, color: "var(--teal-2)" }}>{msg}</div>}
        </Panel>
      )}

      {canManage && (requests.data ?? []).length > 0 && (
        <Panel title="Pending requests" tag={`${(requests.data ?? []).length}`} bodyStyle={{ padding: 0 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>User</th><th>Message</th><th>Requested</th><th></th></tr></thead>
              <tbody>
                {(requests.data ?? []).map((r) => (
                  <tr key={r.id}>
                    <td><div style={{ fontWeight: 600 }}>{r.display_name || r.username}</div><div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>@{r.username}</div></td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.message || "—"}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{ago(r.created_at)}</td>
                    <td className="rowflex" style={{ gap: 6, justifyContent: "flex-end" }}>
                      <button className="btn sm primary" onClick={() => decide(r.id, "approved")}>approve</button>
                      <button className="btn sm ghost danger" onClick={() => decide(r.id, "denied")}>deny</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Members" tag={`${d?.members.length ?? 0}`} bodyStyle={{ padding: 0 }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>User</th><th>Role</th><th>Joined</th><th></th></tr></thead>
            <tbody>
              {(d?.members ?? []).map((m) => (
                <tr key={m.user_id}>
                  <td><div style={{ fontWeight: 600 }}>{m.display_name || m.username}</div><div className="mono" style={{ fontSize: 10, color: "var(--txt-3)" }}>@{m.username}</div></td>
                  <td>
                    <select className="select" style={{ width: "auto", padding: "5px 8px", fontSize: 12 }} value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{ago(m.created_at)}</td>
                  <td><button className="btn sm ghost danger" onClick={() => remove(m.user_id)}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {current.visibility !== "public" && (
        <Panel title="Add member" tag="by username" bodyStyle={{ padding: 16 }}>
          <form onSubmit={add} className="rowflex" style={{ gap: 10, flexWrap: "wrap" }}>
            <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            <select className="select" style={{ width: "auto" }} value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn primary" disabled={busy || !username.trim() || !canManage}>Add</button>
          </form>
          {msg && <div className="mono" style={{ marginTop: 12, fontSize: 11.5, color: "var(--teal-2)" }}>{msg}</div>}
        </Panel>
      )}
    </div>
  );
}
