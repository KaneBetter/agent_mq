// Process-wide event bus + SSE fan-out for GET /api/events.
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { LiveEvent } from "@agentmq/shared";

const BUS_EVENT = "live";
const SSE_HEARTBEAT_MS = 15_000;

class EventBus extends EventEmitter {
  constructor() {
    super();
    // Many concurrent SSE subscribers (dashboard tabs, agents) are expected.
    this.setMaxListeners(0);
  }

  publish(event: LiveEvent): void {
    this.emit(BUS_EVENT, event);
  }
}

export const eventBus = new EventBus();

/** Fire-and-forget persistence hook, wired by index.ts once the DB pool exists. */
type ActivitySink = (event: LiveEvent) => void;
let activitySink: ActivitySink | null = null;

/** Registers the sink that persists every emitted event to the `activity` table. */
export function setActivitySink(sink: ActivitySink): void {
  activitySink = sink;
}

export function emitEvent(event: Omit<LiveEvent, "ts"> & { ts?: string }): void {
  const fullEvent: LiveEvent = { ts: new Date().toISOString(), ...event };
  eventBus.publish(fullEvent);
  if (activitySink) {
    try {
      activitySink(fullEvent);
    } catch (err) {
      console.error("[events] activity sink threw synchronously", err);
    }
  }
}

/** Registers `request`/`reply` as an SSE stream that forwards bus events as JSON. */
export function handleSseRequest(request: FastifyRequest, reply: FastifyReply): void {
  // Take over the raw socket so Fastify does not try to serialize its own reply.
  // Without this the response is never flushed and the browser's EventSource
  // stays stuck in "connecting" (onopen never fires).
  reply.hijack();

  // We write headers on the raw response, which bypasses Fastify's CORS hook,
  // so echo the CORS header here for the cross-origin (web:5173 → api:4000) case.
  const origin = (request.headers.origin as string | undefined) ?? "*";
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  });
  // Flush headers immediately (fires onopen) and hint the client reconnect delay.
  reply.raw.write("retry: 3000\n\n");
  reply.raw.write(`: connected ${Date.now()}\n\n`);

  const send = (event: LiveEvent): void => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  eventBus.on(BUS_EVENT, send);

  const heartbeat = setInterval(() => {
    reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    eventBus.off(BUS_EVENT, send);
  };

  request.raw.on("close", cleanup);
  reply.raw.on("close", cleanup);
}
