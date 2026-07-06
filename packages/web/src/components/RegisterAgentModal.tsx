import { useState } from "react";
import type { RegisterAgentResponse } from "@agentmq/shared";
import { api, API_BASE } from "../api";
import { Modal, Tags } from "./ui";

interface Props {
  /** Pre-bind registration to this project (register + auto-subscribe in one step). */
  project?: { id: string; name: string } | null;
  onClose: () => void;
  onRegistered?: () => void;
}

export function RegisterAgentModal({ project, onClose, onRegistered }: Props) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [caps, setCaps] = useState("cpu");
  const [concurrency, setConcurrency] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RegisterAgentResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.registerAgent({
        name: name.trim(),
        owner: owner.trim() || undefined,
        capabilities: caps.split(",").map((s) => s.trim()).filter(Boolean),
        max_concurrency: concurrency,
        project_id: project?.id,
      });
      setDone(res);
      onRegistered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const runCmd =
    `pnpm agentctl register --name "${name || "my-machine"}"` +
    (owner ? ` --owner "${owner}"` : "") +
    ` --caps ${caps || "cpu"}` +
    (project ? ` --project ${project.name}` : "") +
    ` --server ${API_BASE}` +
    (project ? `\npnpm agentctl schedule install --interval 60 --project ${project.name}` : "") +
    `\npnpm agentctl run`;

  return (
    <Modal
      title={done ? "Consumer registered" : "Register consumer"}
      tag={project ? `→ ${project.name}` : "global"}
      onClose={onClose}
    >
      {!done ? (
        <form onSubmit={submit}>
          {project && (
            <div className="routing-note" style={{ marginBottom: 16 }}>
              This consumer will be <b>registered and subscribed to {project.name}</b> in one step,
              so it can immediately claim tasks from this project.
            </div>
          )}
          <label className="fld">
            <span>machine name</span>
            <input className="input" placeholder="e.g. alice-macbook" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <label className="fld" style={{ flex: 1 }}>
              <span>owner</span>
              <input className="input" placeholder="who runs it" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </label>
            <label className="fld" style={{ width: 130 }}>
              <span>max concurrency</span>
              <input className="input" type="number" min={1} max={16} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value) || 1)} />
            </label>
          </div>
          <label className="fld">
            <span>capabilities (comma-sep)</span>
            <input className="input" placeholder="cpu, gpu, shell" value={caps} onChange={(e) => setCaps(e.target.value)} />
          </label>
          {error && <div className="mono" style={{ color: "var(--rose-2)", fontSize: 11.5, marginBottom: 12 }}>✗ {error}</div>}
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? "Registering…" : "Register consumer"}
          </button>
        </form>
      ) : (
        <div>
          <div className="routing-note" style={{ marginBottom: 16 }}>
            <b>{done.agent.name}</b> is registered
            {project ? <> and subscribed to <b>{project.name}</b></> : null}. Give the token and
            command below to the colleague who runs this machine.
          </div>

          <div className="section-label">consumer id</div>
          <div className="token-box" style={{ marginBottom: 12 }}>{done.agent_id}</div>

          <div className="section-label">api token (store securely)</div>
          <div className="rowflex" style={{ alignItems: "stretch", marginBottom: 12 }}>
            <div className="token-box" style={{ flex: 1 }}>{done.api_token}</div>
            <button className="btn sm" onClick={() => copy(done.api_token, "token")}>
              {copied === "token" ? "✓" : "copy"}
            </button>
          </div>

          {done.agent.capabilities.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <Tags tags={done.agent.capabilities} />
            </div>
          )}

          <div className="section-label">run it on the machine</div>
          <div className="rowflex" style={{ alignItems: "stretch", marginBottom: 16 }}>
            <pre className="code-preview" style={{ flex: 1, margin: 0 }}>{runCmd}</pre>
            <button className="btn sm" onClick={() => copy(runCmd, "cmd")}>
              {copied === "cmd" ? "✓" : "copy"}
            </button>
          </div>

          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      )}
    </Modal>
  );
}
