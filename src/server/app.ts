import Fastify, { type FastifyInstance } from "fastify";
import { DiscoverySessionStore } from "../domain/discovery-session.js";
import {
  InMemoryDiscoveryEventStore,
  type DiscoveryEventStore
} from "../domain/discovery-event.js";

const discoveryEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_id", "session_id", "sequence", "event_type", "occurred_at", "platform", "payload"],
  properties: {
    event_id: { type: "string", format: "uuid" },
    session_id: { type: "string", format: "uuid" },
    sequence: { type: "integer", minimum: 1 },
    event_type: { type: "string", enum: ["screen_observed", "element_observed", "action_candidate", "action_executed", "transition_observed", "assertion_observed", "error", "session_marker"] },
    occurred_at: { type: "string", format: "date-time" },
    platform: { type: "string", enum: ["web", "android", "ios", "hybrid"] },
    screen_id: { type: ["string", "null"], format: "uuid" },
    state_id: { type: ["string", "null"], format: "uuid" },
    transition_id: { type: ["string", "null"], format: "uuid" },
    payload: { type: "object", additionalProperties: true },
    evidence_ids: { type: "array", items: { type: "string", format: "uuid" } }
  }
} as const;

const createSessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["application_id", "platform", "target_id"],
  properties: {
    application_id: { type: "string", minLength: 1, maxLength: 200 },
    platform: { type: "string", enum: ["web", "android", "ios", "hybrid"] },
    target_id: { type: "string", minLength: 1, maxLength: 200 }
  }
} as const;

const transitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["running", "completed", "failed", "cancelled"] },
    failure_reason: { type: "string", maxLength: 2000 }
  }
} as const;

export interface AppOptions {
  store?: DiscoveryEventStore;
  sessions?: DiscoverySessionStore;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const store = options.store ?? new InMemoryDiscoveryEventStore();
  const sessions = options.sessions ?? new DiscoverySessionStore();

  app.get("/health", async () => ({ status: "ok", service: "reverse-screen" }));

  app.post<{ Body: { application_id: string; platform: "web" | "android" | "ios" | "hybrid"; target_id: string } }>(
    "/v1/discovery-sessions",
    { schema: { body: createSessionSchema } },
    async (request, reply) => reply.code(201).send(sessions.create(request.body))
  );

  app.get("/v1/discovery-sessions", async () => ({ items: sessions.list() }));

  app.get<{ Params: { sessionId: string } }>("/v1/discovery-sessions/:sessionId", async (request, reply) => {
    const session = sessions.get(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: "discovery_session_not_found" });
    return session;
  });

  app.post<{ Params: { sessionId: string }; Body: { status: "running" | "completed" | "failed" | "cancelled"; failure_reason?: string } }>(
    "/v1/discovery-sessions/:sessionId/transitions",
    { schema: { body: transitionSchema } },
    async (request, reply) => {
      const session = sessions.transition(request.params.sessionId, request.body.status, request.body.failure_reason);
      if (!session) return reply.code(409).send({ error: "invalid_session_transition" });
      return session;
    }
  );

  app.post<{ Body: Parameters<DiscoveryEventStore["append"]>[0] }>(
    "/v1/discovery-events",
    { schema: { body: discoveryEventSchema } },
    async (request, reply) => {
      const result = store.append(request.body);
      return reply.code(result.duplicate ? 200 : 202).send({ accepted: true, duplicate: result.duplicate, event: result.event });
    }
  );

  app.get<{ Params: { sessionId: string } }>("/v1/discovery-sessions/:sessionId/events", async (request) => ({
    session_id: request.params.sessionId,
    events: store.listBySession(request.params.sessionId)
  }));

  return app;
}
