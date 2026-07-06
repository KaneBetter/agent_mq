import { useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";

/**
 * Homepage call-to-action: connect an agent by pasting a prompt into an LLM
 * coding agent. The agent self-registers and installs its poll schedules.
 */
export function ConnectAgent() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const { data } = usePoll(() => api.onboarding(), [], 0);

  function copy(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <section
      className="panel"
      style={{
        marginBottom: 20,
        borderColor: "rgba(201,120,26,0.35)",
        background: "linear-gradient(100deg, var(--amber-tint), var(--bg-1) 60%)",
      }}
    >
      <div className="rowflex" style={{ padding: "14px 18px", flexWrap: "wrap" }}>
        <span style={{ fontSize: 20 }}>🛰</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600, letterSpacing: "0.04em" }}>
            Connect a consumer
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Paste one prompt into your LLM coding agent (Claude Code, etc.). It self-registers, subscribes,
            and sets up its own poll schedule — no manual setup.
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {data && (
            <button className="btn sm" onClick={() => copy(data.prompt, "prompt")}>
              {copied === "prompt" ? "✓ copied" : "Copy connect prompt"}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "show prompt"}
          </button>
        </div>
      </div>

      {open && data && (
        <div style={{ padding: "0 18px 18px" }}>
          <div className="section-label">install</div>
          <div className="rowflex" style={{ alignItems: "stretch", marginBottom: 14 }}>
            <pre className="code-preview" style={{ flex: 1, margin: 0 }}>{data.install_cmd}</pre>
            <button className="btn sm" onClick={() => copy(data.install_cmd, "install")}>
              {copied === "install" ? "✓" : "copy"}
            </button>
          </div>
          <div className="section-label">the connect prompt (give this to your agent)</div>
          <pre className="code-preview" style={{ maxHeight: 340 }}>{data.prompt}</pre>
          <div className="muted mono" style={{ fontSize: 10.5, marginTop: 8 }}>
            server: {data.server_url}
          </div>
        </div>
      )}
    </section>
  );
}
