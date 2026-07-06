import { useMemo, useState } from "react";
import type { CalendarDay } from "@agentmq/shared";
import { api } from "../api";
import { usePoll } from "../hooks";
import { hm, monthGrid, monthName, shortId, ymd } from "../format";
import { Drawer, Panel, StatusPill, Tags } from "../components/ui";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Calendar({ live, initialProject }: { live: boolean; initialProject?: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [projectId, setProjectId] = useState(initialProject ?? "");
  const [selected, setSelected] = useState<string | null>(null);

  const todayKey = ymd(now);
  const grid = useMemo(() => monthGrid(year, month, todayKey), [year, month, todayKey]);
  const from = grid[0].key;
  const to = grid[grid.length - 1].key;

  const projects = usePoll(() => api.projects(), [], 0);
  const cal = usePoll(
    () => api.calendar({ project_id: projectId, from, to }),
    [projectId, from, to],
    live ? 4000 : 0
  );

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    for (const d of cal.data?.days ?? []) m.set(d.date, d);
    return m;
  }, [cal.data]);

  const maxActivity = useMemo(() => {
    let mx = 1;
    for (const d of cal.data?.days ?? []) mx = Math.max(mx, d.activity_total);
    return mx;
  }, [cal.data]);

  function step(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setMonth(m);
    setYear(y);
  }

  const selectedDay = selected ? byDate.get(selected) : null;

  return (
    <>
      <Panel
        title="Calendar"
        tag="activity + scheduled"
        right={
          <div className="filters">
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">all topics</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        }
        bodyStyle={{ padding: 18 }}
      >
        <div className="cal-toolbar">
          <button className="btn sm ghost" onClick={() => step(-1)}>‹ prev</button>
          <div className="cal-title">{monthName(month)} {year}</div>
          <button className="btn sm ghost" onClick={() => step(1)}>next ›</button>
          <button className="btn sm ghost" onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); }}>today</button>
        </div>

        <div className="cal-grid">
          {DOW.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
          {grid.map((cell) => {
            const day = byDate.get(cell.key);
            const total = day?.activity_total ?? 0;
            const completed = day?.completed ?? 0;
            const failed = day?.failed ?? 0;
            const published = day?.published ?? 0;
            const scheduled = day?.scheduled ?? [];
            const h = (v: number) => `${Math.max(v > 0 ? 3 : 0, (v / maxActivity) * 20)}px`;
            return (
              <div
                key={cell.key}
                className={`cal-cell${cell.inMonth ? "" : " out"}${cell.isToday ? " today" : ""}`}
                onClick={() => setSelected(cell.key)}
              >
                <div className="cal-daynum">
                  {cell.date.getDate()}
                  {scheduled.length > 0 && <span className="fut">◷{scheduled.length}</span>}
                </div>
                {scheduled.length > 0 && (
                  <div className="cal-sched">
                    {scheduled.slice(0, 8).map((s) => <span className="dot" key={s.id} title={s.type} />)}
                  </div>
                )}
                {total > 0 && (
                  <>
                    <div className="cal-count">{total} events</div>
                    <div className="cal-bars">
                      <div className="cal-bar" style={{ height: h(completed), background: "var(--completed)" }} title={`${completed} completed`} />
                      <div className="cal-bar" style={{ height: h(published), background: "var(--slate)" }} title={`${published} published`} />
                      <div className="cal-bar" style={{ height: h(failed), background: "var(--dead)" }} title={`${failed} failed`} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="cal-legend">
          <span><i style={{ background: "var(--completed)" }} /> completed</span>
          <span><i style={{ background: "var(--slate)" }} /> published</span>
          <span><i style={{ background: "var(--dead)" }} /> failed</span>
          <span><i style={{ background: "var(--scheduled)", borderRadius: "50%" }} /> scheduled (upcoming)</span>
        </div>
      </Panel>

      {selected && (
        <Drawer
          title={new Date(selected + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          tag={selected}
          onClose={() => setSelected(null)}
        >
          {selectedDay ? (
            <>
              <dl className="kv" style={{ marginBottom: 18 }}>
                <dt>Total events</dt><dd className="mono">{selectedDay.activity_total}</dd>
                <dt>Completed</dt><dd className="mono" style={{ color: "var(--teal-2)" }}>{selectedDay.completed}</dd>
                <dt>Published</dt><dd className="mono">{selectedDay.published}</dd>
                <dt>Failed</dt><dd className="mono" style={{ color: "var(--rose-2)" }}>{selectedDay.failed}</dd>
              </dl>
              <div className="section-label">Scheduled messages ({selectedDay.scheduled.length})</div>
              {selectedDay.scheduled.length === 0 ? (
                <div className="muted mono" style={{ fontSize: 12 }}>none scheduled this day</div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {selectedDay.scheduled.map((s) => (
                    <div key={s.id} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: 10 }}>
                      <div className="rowflex">
                        <span className="mono" style={{ color: "var(--txt-0)" }}>{s.type}</span>
                        <span className="mono" style={{ marginLeft: "auto", color: "var(--scheduled)" }}>◷ {hm(s.scheduled_for)}</span>
                      </div>
                      <div className="rowflex" style={{ marginTop: 6, gap: 8 }}>
                        <span style={{ color: "var(--teal-2)", fontSize: 12 }}>{s.project_name}</span>
                        <span className="muted mono" style={{ fontSize: 10 }}>#{shortId(s.id)}</span>
                        <StatusPill status={s.status} />
                      </div>
                      {s.tags.length > 0 && <div style={{ marginTop: 6 }}><Tags tags={s.tags} /></div>}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="muted mono" style={{ fontSize: 12 }}>no data for this day</div>
          )}
        </Drawer>
      )}
    </>
  );
}
