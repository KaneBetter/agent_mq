import { useState } from "react";
import type { RegisterAgentResponse } from "@agentmq/shared";
import { api, API_BASE } from "../api";
import { usePoll } from "../hooks";
import { useSpaces } from "../spaceContext";
import { buildConsumerPrompt } from "../consumerPrompt";
import { Modal, Tags } from "./ui";

interface Props {
  /** Pre-bind registration to this project (register + auto-subscribe in one step). */
  project?: { id: string; name: string } | null;
  onClose: () => void;
  onRegistered?: () => void;
}

const FALLBACK_INSTALL = "git clone <the agent-mq repo> agent_mq && cd agent_mq && pnpm install";

export function RegisterAgentModal({ project, onClose, onRegistered }: Props) {
  const { current } = useSpaces();
  const onboarding = usePoll(() => api.onboarding(), [], 0);
  // The consumer is an AI agent by default: hand it a prompt, it self-registers
  // and runs the loop. "manual" is the escape hatch for a headless machine.
  const [mode, setMode] = useState<"prompt" | "manual">("prompt");
  const [caps, setCaps] = useState("cpu");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [concurrency, setConcurrency] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RegisterAgentResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const spaceSlug = current?.slug ?? current?.name ?? "Public";

  const consumerPrompt = buildConsumerPrompt({
    topicName: project?.name ?? "<topic>",
    spaceSlug,
    server: API_BASE,
    caps: caps || "cpu",
    installCmd: onboarding.data?.install_cmd ?? FALLBACK_INSTALL,
  });

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
        space_id: current?.id,
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
    `pnpm agent-mq login --server ${API_BASE}\n` +
    `pnpm agent-mq schedule install --interval 86400\n` +
    `pnpm agent-mq register --name "${name || "my-machine"}"` +
    ` --space ${spaceSlug}` +
    (owner ? ` --owner "${owner}"` : "") +
    ` --caps ${caps || "cpu"}` +
    (project ? ` --project ${project.name}` : "") +
    `\npnpm agent-mq schedule install --interval 86400 --space ${spaceSlug}` +
    (project ? `\npnpm agent-mq subscribe --project ${project.name}` : "") +
    (project ? `\npnpm agent-mq schedule install --interval 3600 --project ${project.name}` : "") +
    `\npnpm agent-mq run`;

  return (
    <Modal
      title={done ? "Consumer registered" : "Register consumer"}
      tag={project ? `→ ${project.name}` : "global"}
      onClose={onClose}
    >
      {mode === "prompt" && !done ? (
        <div>
          <div className="routing-note" style={{ marginBottom: 16 }}>
            Give this prompt to your <b>AI coding agent</b> (Claude Code, etc.). It registers itself
            as a consumer of {project ? <b>{project.name}</b> : <>the current space</>} and runs the
            loop — pulling messages, doing the <b>real</b> work, reporting progress back to each
            message, and completing.
          </div>
          <label className="fld">
            <span>capabilities the agent's machine has (comma-sep)</span>
            <input className="input" placeholder="cpu, gpu, shell" value={caps} onChange={(e) => setCaps(e.target.value)} />
          </label>
          <div className="section-label">prompt for your AI agent</div>
          <pre className="code-preview" style={{ margin: "0 0 14px", maxHeight: 360 }}>{consumerPrompt}</pre>
          <div className="rowflex" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => copy(consumerPrompt, "prompt")}>
              {copied === "prompt" ? "✓ copied" : "Copy prompt for your AI agent"}
            </button>
            <button className="btn ghost sm" onClick={() => setMode("manual")}>
              or register a headless machine manually →
            </button>
          </div>
        </div>
      ) : !done ? (
        <form onSubmit={submit}>
          <button type="button" className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => setMode("prompt")}>
            ‹ back to the AI-agent prompt
          </button>
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
