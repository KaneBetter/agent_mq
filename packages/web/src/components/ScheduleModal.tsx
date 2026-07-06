import { useState } from "react";
import type { CreateScheduleRequest, Recurrence, RecurrenceKind } from "@agentmq/shared";
import { api } from "../api";
import { Modal } from "./ui";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  project: { id: string; name: string };
  onClose: () => void;
  onCreated?: () => void;
}

export function ScheduleModal({ project, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [kind, setKind] = useState<RecurrenceKind>("weekly");
  const [intervalVal, setIntervalVal] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState(3600); // seconds per unit
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [times, setTimes] = useState("00:00, 06:00, 12:00, 18:00");
  const [tz, setTz] = useState("UTC");
  const [shiftHours, setShiftHours] = useState<string>("6");
  const [tags, setTags] = useState("");
  const [payload, setPayload] = useState('{\n  "role": "primary"\n}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyOncallPreset() {
    setName("Weekday duty roster");
    setType("oncall.shift");
    setKind("weekly");
    setDays([1, 2, 3, 4, 5]);
    setTimes("00:00, 06:00, 12:00, 18:00");
    setShiftHours("6");
    setPayload('{\n  "role": "primary"\n}');
  }

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  }

  const payloadValid = (() => {
    try { JSON.parse(payload || "{}"); return true; } catch { return false; }
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !type.trim() || !payloadValid) return;
    const recurrence: Recurrence =
      kind === "interval"
        ? { kind: "interval", interval_seconds: Math.max(1, intervalVal) * intervalUnit }
        : {
            kind: "weekly",
            days_of_week: days,
            times: times.split(",").map((s) => s.trim()).filter(Boolean),
            timezone: tz.trim() || "UTC",
          };
    const body: CreateScheduleRequest = {
      project_id: project.id,
      name: name.trim(),
      type: type.trim(),
      payload_template: JSON.parse(payload || "{}"),
      tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
      recurrence,
      shift_hours: shiftHours.trim() ? Number(shiftHours) : null,
      enabled: true,
    };
    setBusy(true);
    setError(null);
    try {
      await api.createSchedule(body);
      onCreated?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New schedule" tag={`→ ${project.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="rowflex" style={{ marginBottom: 14 }}>
          <button type="button" className="btn sm" onClick={applyOncallPreset}>
            ⏱ On-call roster preset
          </button>
          <span className="muted mono" style={{ fontSize: 10.5 }}>Mon–Fri · 4×6h shifts</span>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <label className="fld" style={{ flex: 2 }}>
            <span>name</span>
            <input className="input" placeholder="e.g. Weekday duty roster" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="fld" style={{ flex: 1 }}>
            <span>task type</span>
            <input className="input" placeholder="oncall.shift" value={type} onChange={(e) => setType(e.target.value)} />
          </label>
        </div>

        <label className="fld">
          <span>recurrence</span>
          <div className="rowflex" style={{ gap: 8 }}>
            <button type="button" className={`btn sm${kind === "weekly" ? " primary" : " ghost"}`} onClick={() => setKind("weekly")}>weekly</button>
            <button type="button" className={`btn sm${kind === "interval" ? " primary" : " ghost"}`} onClick={() => setKind("interval")}>interval</button>
          </div>
        </label>

        {kind === "interval" ? (
          <div style={{ display: "flex", gap: 12 }}>
            <label className="fld" style={{ flex: 1 }}>
              <span>every</span>
              <input className="input" type="number" min={1} value={intervalVal} onChange={(e) => setIntervalVal(Number(e.target.value) || 1)} />
            </label>
            <label className="fld" style={{ flex: 1 }}>
              <span>unit</span>
              <select className="select" value={intervalUnit} onChange={(e) => setIntervalUnit(Number(e.target.value))}>
                <option value={60}>minutes</option>
                <option value={3600}>hours</option>
                <option value={86400}>days</option>
              </select>
            </label>
          </div>
        ) : (
          <>
            <label className="fld">
              <span>days of week</span>
              <div className="rowflex" style={{ gap: 6, flexWrap: "wrap" }}>
                {DOW.map((d, i) => (
                  <button key={d} type="button" className={`btn sm${days.includes(i) ? " primary" : " ghost"}`} onClick={() => toggleDay(i)}>
                    {d}
                  </button>
                ))}
              </div>
            </label>
            <div style={{ display: "flex", gap: 12 }}>
              <label className="fld" style={{ flex: 2 }}>
                <span>times (comma HH:MM)</span>
                <input className="input" placeholder="00:00, 06:00, 12:00, 18:00" value={times} onChange={(e) => setTimes(e.target.value)} />
              </label>
              <label className="fld" style={{ flex: 1 }}>
                <span>timezone</span>
                <input className="input" placeholder="UTC" value={tz} onChange={(e) => setTz(e.target.value)} />
              </label>
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          <label className="fld" style={{ flex: 1 }}>
            <span>shift hours (optional)</span>
            <input className="input" type="number" min={0} placeholder="6" value={shiftHours} onChange={(e) => setShiftHours(e.target.value)} />
          </label>
          <label className="fld" style={{ flex: 1 }}>
            <span>tags</span>
            <input className="input" placeholder="duty, ops" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
        </div>

        <label className="fld">
          <span>payload template (json)</span>
          <textarea className="textarea" style={{ minHeight: 84, ...(payloadValid ? {} : { borderColor: "var(--rose)" }) }} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />
        </label>

        {error && <div className="mono" style={{ color: "var(--rose-2)", fontSize: 11.5, marginBottom: 12 }}>✗ {error}</div>}
        <button className="btn primary" disabled={busy || !name.trim() || !type.trim() || !payloadValid}>
          {busy ? "Creating…" : "Create schedule"}
        </button>
      </form>
    </Modal>
  );
}
