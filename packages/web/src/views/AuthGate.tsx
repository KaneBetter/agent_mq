import { useState } from "react";
import { useAuth } from "../auth";

export function AuthGate() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(username.trim(), password);
      else await register(username.trim(), password, displayName.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark" style={{ width: 36, height: 36 }}>
            <span className="ring" />
            <span className="core" />
          </div>
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>agent<span>·</span>mq</div>
            <div className="brand-sub">broker · sign in</div>
          </div>
        </div>

        <div className="auth-tabs">
          <button className={`auth-tab${mode === "login" ? " active" : ""}`} onClick={() => setMode("login")}>Sign in</button>
          <button className={`auth-tab${mode === "register" ? " active" : ""}`} onClick={() => setMode("register")}>Create account</button>
        </div>

        <form onSubmit={submit}>
          <label className="fld">
            <span>username</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </label>
          {mode === "register" && (
            <label className="fld">
              <span>display name (optional)</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          )}
          <label className="fld">
            <span>password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </label>
          {error && <div className="mono" style={{ color: "var(--rose-2)", fontSize: 11.5, marginBottom: 12 }}>✗ {error}</div>}
          <button className="btn primary" style={{ width: "100%" }} disabled={busy || !username.trim() || !password}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="auth-hint">
          demo account: <span className="mono">demo</span> / <span className="mono">demo</span>
        </div>
      </div>
    </div>
  );
}
