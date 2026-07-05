import type { EventType, TaskStatus } from "@agentmq/shared";

export function compactNum(n: number | null | undefined): string {
  if (n == null) return "0";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}

export function usd(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

export function duration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${rs.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clockTime(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.slice(0, 8);
}

/** Color CSS var for a task status. */
export function statusColor(s: TaskStatus): string {
  return `var(--${s.toLowerCase()})`;
}

/** Color var for an event kind (drives the activity stream dot). */
export function eventColor(t: EventType): string {
  if (t.startsWith("agent.")) return "var(--cyan)";
  switch (t) {
    case "task.published":
      return "var(--slate)";
    case "task.claimed":
      return "var(--claimed)";
    case "task.running":
      return "var(--running)";
    case "task.completed":
      return "var(--completed)";
    case "task.failed":
    case "task.requeued":
      return "var(--failed)";
    case "task.dead":
    case "task.canceled":
      return "var(--dead)";
    case "reaper.reclaimed":
      return "var(--violet)";
    default:
      return "var(--slate)";
  }
}

export function eventVerb(t: EventType): string {
  const map: Record<EventType, string> = {
    "task.published": "published",
    "task.claimed": "claimed",
    "task.running": "running",
    "task.completed": "completed",
    "task.failed": "failed",
    "task.requeued": "requeued",
    "task.dead": "dead-lettered",
    "task.canceled": "canceled",
    "agent.registered": "registered",
    "agent.online": "online",
    "agent.offline": "offline",
    "reaper.reclaimed": "reclaimed",
  };
  return map[t] ?? t;
}
