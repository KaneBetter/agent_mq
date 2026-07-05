import type { ReactNode } from "react";
import type { AgentStatus, TaskStatus } from "@agentmq/shared";

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className={`pill ${status}`}>
      <span className="pd" />
      {status}
    </span>
  );
}

export function AgentPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`pill ${status}`}>
      <span className="pd" />
      {status}
    </span>
  );
}

export function Cap({ children }: { children: ReactNode }) {
  return <span className="chip cap">{children}</span>;
}

export function Caps({ caps }: { caps: string[] }) {
  if (!caps.length) return <span className="muted mono" style={{ fontSize: 11 }}>any</span>;
  return (
    <span className="chips">
      {caps.map((c) => (
        <Cap key={c}>{c}</Cap>
      ))}
    </span>
  );
}

export function Panel({
  title,
  tag,
  right,
  children,
  bodyStyle,
}: {
  title?: string;
  tag?: string;
  right?: ReactNode;
  children: ReactNode;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          <h2>{title}</h2>
          {tag && <span className="tag">{tag}</span>}
          <span className="spacer" />
          {right}
        </div>
      )}
      <div style={bodyStyle}>{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  accent,
  plain,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: string;
  plain?: boolean;
}) {
  return (
    <div className="kpi" style={accent ? ({ "--accent": accent } as React.CSSProperties) : undefined}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${plain ? " plain" : ""}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="progress-bar">
      <i style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Drawer({
  title,
  tag,
  onClose,
  children,
}: {
  title: ReactNode;
  tag?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 14, letterSpacing: "0.06em" }}>
            {title}
          </h2>
          {tag && <span className="tag">{tag}</span>}
          <span className="close-x" onClick={onClose}>
            ×
          </span>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
