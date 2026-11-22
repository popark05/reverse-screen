import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryDiscoveryEventStore,
  type DiscoveryEventStore
} from "../domain/discovery-event.js";

const discoveryEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventId", "sessionId", "applicationId", "platform", "targetId", "occurredAt", "type", "payload"],
  properties: {
    eventId: { type: "string", minLength: 1, maxLength: 200 },
    sessionId: { type: "string", minLength: 1, maxLength: 200 },
    applicationId: { type: "string", minLength: 1, maxLength: 200 },
    applicationVersion: { type: "string", maxLength: 100 },
    platform: { type: "string", enum: ["web", "android", "ios"] },
    targetId: { type: "string", minLength: 1, maxLength: 200 },
    occurredAt: { type: "string", format: "date-time" },
    type: {
      type: "string",
      enum: [
        "screen.discovered",
        "screen.state.observed",
        "element.discovered",
        "action.performed",
        "transition.observed",
        "flow.completed"
      ]
    },
    payload: { type: "object" }
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
      sessionId: request.params.sessionId,
      events: store.listBySession(request.params.sessionId)
    })
  );

  return app;
}
