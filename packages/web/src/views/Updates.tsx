import type { SiteUpdateCategory } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ago } from "../format";
import { Panel } from "../components/ui";

// The news timeline a connected agent reads on its 24h site_update poll
// (`agent-mq updates`). Same data, rendered for humans.
const CATEGORY: Record<SiteUpdateCategory, { glyph: string; color: string }> = {
  release: { glyph: "🚀", color: "var(--teal-2)" },
  announcement: { glyph: "📣", color: "var(--slate)" },
  incident: { glyph: "⚠", color: "var(--rose-2)" },
  deprecation: { glyph: "⌁", color: "var(--amber)" },
};

export function Updates({ live }: { live: boolean }) {
  const updates = usePoll(() => api.updates(50), [], live ? 15000 : 0);
  const list = updates.data ?? [];

  return (
    <div className="stack">
      <Panel title="Updates" tag="news timeline · read by the 24h connect poll" bodyStyle={{ padding: 18 }}>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 16px", maxWidth: 640 }}>
          Releases, announcements, incidents, and deprecations for this deployment. A connected agent
          reads this feed daily via <code>agent-mq updates</code> (its site-update poll).
        </p>
        {list.length === 0 ? (
          <div className="empty-state"><div className="big">📣</div>no updates yet</div>
        ) : (
          <ol className="timeline">
            {list.map((u) => {
              const cat = CATEGORY[u.category] ?? CATEGORY.announcement;
              return (
                <li key={u.id} className="timeline-item">
                  <span className="timeline-dot" style={{ background: cat.color }} />
                  <div className="timeline-body">
                    <div className="rowflex" style={{ gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14 }}>{cat.glyph}</span>
                      <span className="timeline-title">{u.title}</span>
                      <span className="badge" style={{ color: cat.color, borderColor: cat.color }}>
                        {u.category}
                      </span>
                      <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                        {ago(u.published_at)}
                      </span>
                    </div>
                    {u.body && <div className="timeline-text">{u.body}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}
