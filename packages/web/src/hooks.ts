import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveEvent } from "@agentmq/shared";
import { API_BASE } from "./api";

export type ConnState = "connecting" | "open" | "closed";

/**
 * Subscribe to the server SSE bus. Buffers the most recent events and exposes
 * a monotonically-increasing `pulse` so consumers can cheaply react to any new
 * event (e.g. refetch). Auto-reconnects with backoff.
 */
export function useEventStream(paused: boolean, max = 220) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [pulse, setPulse] = useState(0);
  const [last, setLast] = useState<LiveEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (paused) {
      esRef.current?.close();
      esRef.current = null;
      setConn("closed");
      return;
    }
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (stopped) return;
      setConn("connecting");
      const es = new EventSource(`${API_BASE}/api/events`);
      esRef.current = es;
      es.onopen = () => !stopped && setConn("open");
      es.onmessage = (m) => {
        if (stopped || !m.data) return;
        try {
          const ev = JSON.parse(m.data) as LiveEvent;
          setEvents((prev) => [ev, ...prev].slice(0, max));
          setLast(ev);
          setPulse((p) => p + 1);
        } catch {
          /* ignore keepalive / malformed */
        }
      };
      es.onerror = () => {
        es.close();
        if (stopped) return;
        setConn("closed");
        retry = setTimeout(connect, 1600);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [paused, max]);

  const clear = useCallback(() => setEvents([]), []);
  return { events, conn, pulse, last, clear };
}

/**
 * Poll an async fetcher on an interval, plus whenever `trigger` changes.
 * Returns data, loading, error and a manual refetch.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  intervalMs = 4000,
  active = true
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      const d = await fetcherRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    run();
    if (!active || intervalMs <= 0) return;
    const t = setInterval(run, intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, active]);

  return { data, error, loading, refetch: run };
}

/** A ticking clock, updates every second. */
export function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
