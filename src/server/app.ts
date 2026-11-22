import Fastify, { type FastifyInstance } from "fastify";
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
    event_type: {
      type: "string",
      enum: [
        "screen_observed",
        "element_observed",
        "action_candidate",
        "action_executed",
        "transition_observed",
        "assertion_observed",
        "error",
        "session_marker"
      ]
    },
    occurred_at: { type: "string", format: "date-time" },
    platform: { type: "string", enum: ["web", "android", "ios", "hybrid"] },
    screen_id: { type: ["string", "null"], format: "uuid" },
    state_id: { type: ["string", "null"], format: "uuid" },
    transition_id: { type: ["string", "null"], format: "uuid" },
    payload: { type: "object", additionalProperties: true },
    evidence_ids: { type: "array", items: { type: "string", format: "uuid" } }
  }
} as const;

export interface AppOptions {
  store?: DiscoveryEventStore;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const store = options.store ?? new InMemoryDiscoveryEventStore();

  app.get("/health", async () => ({ status: "ok", service: "reverse-screen" }));

  app.post<{ Body: Parameters<DiscoveryEventStore["append"]>[0] }>(
    "/v1/discovery-events",
    { schema: { body: discoveryEventSchema } },
    async (request, reply) => {
      const result = store.append(request.body);
      return reply.code(result.duplicate ? 200 : 202).send({
        accepted: true,
        duplicate: result.duplicate,
        event: result.event
      });
    }
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/discovery-sessions/:sessionId/events",
    async (request) => ({
      session_id: request.params.sessionId,
      events: store.listBySession(request.params.sessionId)
    })
  );

  return app;
}
