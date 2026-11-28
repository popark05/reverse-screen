import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryDiscoverySessionStore, type DiscoverySession, type DiscoverySessionRepository
} from "../domain/discovery-session.js";
import {
  InMemoryDiscoveryEventStore, type DiscoveryEvent, type DiscoveryEventStore
} from "../domain/discovery-event.js";
import {
  EVIDENCE_KINDS, InMemoryEvidenceArtifactStore, type CapturedEvidence, type CreateEvidenceArtifactInput,
  type EvidenceArtifactStore
} from "../domain/evidence-artifact.js";
import type { ObjectStorage } from "../infrastructure/object-storage.js";
import type { DiscoveryActionRequest } from "../domain/discovery-action.js";

const discoveryEventSchema = {
  type: "object", additionalProperties: false,
  required: ["event_id", "session_id", "sequence", "event_type", "occurred_at", "platform", "payload"],
  properties: {
    event_id: { type: "string", format: "uuid" }, session_id: { type: "string", format: "uuid" },
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
  type: "object", additionalProperties: false,
  required: ["application_id", "platform", "target_id"],
  properties: {
    application_id: { type: "string", minLength: 1, maxLength: 200 },
    platform: { type: "string", enum: ["web", "android", "ios", "hybrid"] },
    target_id: { type: "string", minLength: 1, maxLength: 200 }
  }
} as const;

const executeActionSchema = {
  type: "object", additionalProperties: false,
  required: ["context_type", "action", "locator_strategy", "screen_id", "state_id", "target_element_key"],
  properties: {
    context_type: { type: "string", enum: ["native", "webview"] },
    action: { type: "string", enum: ["tap", "fill"] },
    locator_strategy: { type: "string", enum: ["label", "test_id", "role_name"] },
    locator_value: { type: "string", minLength: 1, maxLength: 500 },
    locator_role: { type: "string", minLength: 1, maxLength: 100 },
    locator_name: { type: "string", minLength: 1, maxLength: 500 },
    webview_index: { type: "integer", minimum: 0, maximum: 100 },
    screen_id: { type: "string", format: "uuid" },
    state_id: { type: "string", format: "uuid" },
    target_element_key: { type: "string", minLength: 1, maxLength: 500 },
    input_value: { type: "string", maxLength: 10000 }
  }
} as const;

const transitionSchema = {
  type: "object", additionalProperties: false, required: ["status"],
  properties: {
    status: { type: "string", enum: ["running", "completed", "failed", "cancelled"] },
    failure_reason: { type: "string", maxLength: 2000 }
  }
} as const;

const evidenceMetadataProperties = {
  session_id: { type: "string", format: "uuid" },
  event_id: { type: "string", format: "uuid" },
  kind: { type: "string", enum: EVIDENCE_KINDS },
  content_type: { type: "string", minLength: 1, maxLength: 200 },
  byte_size: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  captured_at: { type: "string", format: "date-time" }
} as const;

const createEvidenceSchema = {
  type: "object", additionalProperties: false,
  required: ["session_id", "kind", "content_type", "byte_size", "sha256", "storage_uri", "captured_at"],
  properties: {
    ...evidenceMetadataProperties,
    storage_uri: { type: "string", minLength: 1, maxLength: 2048, pattern: "^(s3|gs|https?)://" }
  }
} as const;

const evidenceUploadSchema = {
  type: "object", additionalProperties: false,
  required: ["session_id", "kind", "content_type", "byte_size", "sha256", "captured_at"],
  properties: evidenceMetadataProperties
} as const;

export interface DiscoveryObservation {
  events: DiscoveryEvent[];
  evidence: CapturedEvidence[];
}
export interface DiscoveryObserver {
  observe(session: DiscoverySession): Promise<DiscoveryEvent[]>;
  observeWithEvidence?(session: DiscoverySession): Promise<DiscoveryObservation>;
  executeAction?(session: DiscoverySession, request: DiscoveryActionRequest): Promise<DiscoveryEvent>;
  close?(): Promise<void>;
}
export interface MobileActionAuthorizationContext {
  session: DiscoverySession;
  action: Omit<DiscoveryActionRequest, "input_value">;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}
export type MobileActionAuthorizer = (context: MobileActionAuthorizationContext) => boolean | Promise<boolean>;
export type EvidenceReadAuthorizer = (headers: Readonly<Record<string, string | string[] | undefined>>) => boolean | Promise<boolean>;
export interface AppOptions {
  store?: DiscoveryEventStore;
  sessions?: DiscoverySessionRepository;
  evidence?: EvidenceArtifactStore;
  observer?: DiscoveryObserver;
  objectStorage?: ObjectStorage;
  objectStorageBucket?: string;
  uploadUrlTtlSeconds?: number;
  downloadUrlTtlSeconds?: number;
  maxEvidenceBytes?: number;
  allowMobileActions?: boolean;
  authorizeMobileAction?: MobileActionAuthorizer;
  authorizeEvidenceRead?: EvidenceReadAuthorizer;
  onClose?: () => Promise<void>;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const store = options.store ?? new InMemoryDiscoveryEventStore();
  const sessions = options.sessions ?? new InMemoryDiscoverySessionStore();
  const evidence = options.evidence ?? new InMemoryEvidenceArtifactStore();
  const uploadTtl = options.uploadUrlTtlSeconds ?? 300;
  const downloadTtl = options.downloadUrlTtlSeconds ?? 300;
  const maxEvidenceBytes = options.maxEvidenceBytes ?? 20 * 1024 * 1024;
  const bucket = options.objectStorageBucket ?? "reverse-screen";
  const evidenceReadAuthorized = async (
    headers: Readonly<Record<string, string | string[] | undefined>>
  ): Promise<"authorized" | "not_configured" | "denied"> => {
    if (!options.authorizeEvidenceRead) return "not_configured";
    try { return await options.authorizeEvidenceRead(headers) ? "authorized" : "denied"; }
    catch { return "denied"; }
  };

  app.addHook("onClose", async () => {
    await options.observer?.close?.();
    await options.onClose?.();
  });
  app.get("/health", async () => ({ status: "ok", service: "reverse-screen" }));
  const actionQueues = new Map<string, Promise<void>>();
  const withSessionActionLock = async <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = actionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    actionQueues.set(sessionId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (actionQueues.get(sessionId) === queued) actionQueues.delete(sessionId);
    }
  };


  app.post<{ Body: { application_id: string; platform: "web" | "android" | "ios" | "hybrid"; target_id: string } }>(
    "/v1/discovery-sessions", { schema: { body: createSessionSchema } },
    async (request, reply) => reply.code(201).send(await sessions.create(request.body))
  );
  app.get("/v1/discovery-sessions", async () => ({ items: await sessions.list() }));
  app.get<{ Params: { sessionId: string } }>("/v1/discovery-sessions/:sessionId", async (request, reply) => {
    const session = await sessions.get(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: "discovery_session_not_found" });
    return session;
  });
  app.post<{ Params: { sessionId: string } }>("/v1/discovery-sessions/:sessionId/observe", async (request, reply) => {
    if (!options.observer) return reply.code(501).send({ error: "discovery_observer_not_configured" });
    const current = await sessions.get(request.params.sessionId);
    if (!current) return reply.code(404).send({ error: "discovery_session_not_found" });
    if (current.status !== "created") return reply.code(409).send({ error: "discovery_session_not_created" });
    const running = await sessions.transition(current.session_id, "running");
    if (!running) return reply.code(409).send({ error: "invalid_session_transition" });
    try {
      let events: DiscoveryEvent[];
      let captured: CapturedEvidence[] = [];
      if (options.objectStorage && options.observer.observeWithEvidence) {
        const observation = await options.observer.observeWithEvidence(running);
        events = observation.events;
        captured = observation.evidence;
      } else {
        events = await options.observer.observe(running);
      }

      for (const item of captured) {
        if (item.bytes.byteLength === 0 || item.bytes.byteLength > maxEvidenceBytes) {
          throw new Error(`evidence_size_out_of_range:${item.bytes.byteLength}`);
        }
        const evidenceId = randomUUID();
        const key = `evidence/${running.session_id}/${evidenceId}`;
        const sha256 = createHash("sha256").update(item.bytes).digest("hex");
        await options.objectStorage!.putObject({
          key, body: item.bytes, contentType: item.content_type, sha256
        });
        const head = await options.objectStorage!.headObject(key);
        const expectedChecksum = Buffer.from(sha256, "hex").toString("base64");
        if (!head || head.byteSize !== item.bytes.byteLength ||
            head.contentType !== item.content_type || head.sha256 !== expectedChecksum) {
          throw new Error("captured_evidence_object_verification_failed");
        }
        const artifactInput: CreateEvidenceArtifactInput = {
          session_id: running.session_id,
          ...(item.event_id ? { event_id: item.event_id } : {}),
          kind: item.kind, content_type: item.content_type, byte_size: item.bytes.byteLength,
          sha256, storage_uri: `s3://${bucket}/${key}`, captured_at: item.captured_at
        };
        const artifact = await evidence.create(artifactInput, evidenceId);
        if (item.event_id) {
          const event = events.find((candidate) => candidate.event_id === item.event_id);
          if (event) event.evidence_ids = [...(event.evidence_ids ?? []), artifact.evidence_id];
        }
      }

      const accepted = [];
      for (const event of events) accepted.push(await store.append(event));
      const completed = await sessions.transition(current.session_id, "completed");
      return reply.code(201).send({
        session: completed, accepted_count: accepted.length,
        evidence_count: captured.length, events: accepted.map((item) => item.event)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await sessions.transition(current.session_id, "failed", reason.slice(0, 2000));
      return reply.code(502).send({ error: "discovery_observation_failed", message: reason });
    }
  });
  app.post<{ Params: { sessionId: string }; Body: DiscoveryActionRequest }>(
    "/v1/discovery-sessions/:sessionId/actions", { schema: { body: executeActionSchema } },
    async (request, reply) => withSessionActionLock(request.params.sessionId, async () => {
      if (!options.allowMobileActions || !options.observer?.executeAction) {
        return reply.code(501).send({ error: "mobile_action_execution_disabled" });
      }
      const current = await sessions.get(request.params.sessionId);
      if (!current) return reply.code(404).send({ error: "discovery_session_not_found" });
      if (current.status !== "completed") return reply.code(409).send({ error: "discovery_session_must_be_completed_before_actions" });
      const action = request.body;
      if (!options.authorizeMobileAction) return reply.code(403).send({ error: "mobile_action_not_authorized" });
      const { input_value: _redactedInput, ...authorizationAction } = action;
      let authorized = false;
      try {
        authorized = await options.authorizeMobileAction({
          session: current,
          action: authorizationAction,
          headers: request.headers
        });
      } catch {
        // Authorization failures are closed and do not expose policy errors or request data.
      }
      if (!authorized) return reply.code(403).send({ error: "mobile_action_not_authorized" });
      if (action.locator_strategy === "role_name" && (!action.locator_role || !action.locator_name)) {
        return reply.code(400).send({ error: "action_role_locator_incomplete" });
      }
      if (action.locator_strategy !== "role_name" && !action.locator_value) {
        return reply.code(400).send({ error: "action_locator_value_required" });
      }
      if (action.action === "fill" && action.input_value === undefined) {
        return reply.code(400).send({ error: "action_input_value_required" });
      }
      if (action.action === "tap" && action.input_value !== undefined) {
        return reply.code(400).send({ error: "action_input_value_not_allowed_for_tap" });
      }
      if (action.context_type === "webview" && current.platform !== "ios" && current.platform !== "android") {
        return reply.code(409).send({ error: "webview_actions_require_mobile_session" });
      }

      const existing = await store.listBySession(current.session_id);
      const latestScreen = [...existing].reverse().find((event) =>
        event.event_type === "screen_observed" &&
        event.payload.context_type === action.context_type &&
        (action.context_type !== "webview" || event.payload.webview_index === (action.webview_index ?? 0))
      );
      const candidate = existing.find((event) =>
        event.event_type === "action_candidate" &&
        event.screen_id === action.screen_id &&
        event.state_id === action.state_id &&
        event.screen_id === latestScreen?.screen_id &&
        event.payload.target_element_key === action.target_element_key &&
        event.payload.context_type === action.context_type &&
        event.payload.action === action.action &&
        event.payload.enabled === true &&
        event.payload.locator_strategy === action.locator_strategy &&
        event.payload.locator_value === action.locator_value &&
        event.payload.locator_role === action.locator_role &&
        event.payload.locator_name === action.locator_name &&
        (action.context_type !== "webview" || event.payload.webview_index === (action.webview_index ?? 0))
      );
      if (!candidate) return reply.code(409).send({ error: "action_candidate_missing_or_stale" });
      let nextSequence = existing.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
      try {
        const executed = await options.observer.executeAction(current, action);
        const acceptedAction = await store.append({ ...executed, sequence: nextSequence++ });
        let observed: DiscoveryEvent[];
        try {
          observed = await options.observer.observe(current);
        } catch {
          const failureEvent: DiscoveryEvent = {
            event_id: randomUUID(), session_id: current.session_id, sequence: nextSequence++,
            event_type: "error", occurred_at: new Date().toISOString(), platform: current.platform,
            payload: {
              operation: "post_action_observation",
              action_event_id: acceptedAction.event.event_id,
              error_code: "post_action_observation_failed"
            }
          };
          await store.append(failureEvent);
          return reply.code(502).send({
            error: "post_action_observation_failed",
            action_event_id: acceptedAction.event.event_id
          });
        }
        const acceptedObservation = [];
        for (const event of observed) {
          acceptedObservation.push(await store.append({
            ...event,
            sequence: nextSequence++,
            payload: { ...event.payload, observation_phase: "post_action" }
          }));
        }
        return reply.code(201).send({
          action: acceptedAction.event,
          observation_events: acceptedObservation.map((item) => item.event)
        });
      } catch {
        const failureEvent: DiscoveryEvent = {
          event_id: randomUUID(), session_id: current.session_id, sequence: nextSequence,
          event_type: "error", occurred_at: new Date().toISOString(), platform: current.platform,
          payload: {
            operation: "execute_action",
            context_type: action.context_type,
            action: action.action,
            locator_strategy: action.locator_strategy,
            error_code: "action_execution_failed"
          }
        };
        await store.append(failureEvent);
        return reply.code(502).send({ error: "discovery_action_failed", event_id: failureEvent.event_id });
      }
    })
  );
  app.post<{ Params: { sessionId: string }; Body: { status: "running" | "completed" | "failed" | "cancelled"; failure_reason?: string } }>(
    "/v1/discovery-sessions/:sessionId/transitions", { schema: { body: transitionSchema } },
    async (request, reply) => {
      const session = await sessions.transition(request.params.sessionId, request.body.status, request.body.failure_reason);
      if (!session) return reply.code(409).send({ error: "invalid_session_transition" });
      return session;
    }
  );
  app.post<{ Body: DiscoveryEvent }>("/v1/discovery-events", { schema: { body: discoveryEventSchema } },
    async (request, reply) => {
      const result = await store.append(request.body);
      return reply.code(result.duplicate ? 200 : 202).send({ accepted: true, duplicate: result.duplicate, event: result.event });
    }
  );
  app.get<{ Params: { sessionId: string } }>("/v1/discovery-sessions/:sessionId/events", async (request) => ({
    session_id: request.params.sessionId, events: await store.listBySession(request.params.sessionId)
  }));

  app.post<{ Body: CreateEvidenceArtifactInput }>("/v1/evidence-artifacts", { schema: { body: createEvidenceSchema } },
    async (request, reply) => {
      const session = await sessions.get(request.body.session_id);
      if (!session) return reply.code(404).send({ error: "discovery_session_not_found" });
      const artifact = await evidence.create(request.body);
      return reply.code(201).send(artifact);
    }
  );

  app.post<{ Body: Omit<CreateEvidenceArtifactInput, "storage_uri"> }>(
    "/v1/evidence-artifacts/upload-url", { schema: { body: evidenceUploadSchema } },
    async (request, reply) => {
      if (!options.objectStorage) return reply.code(501).send({ error: "object_storage_not_configured" });
      const session = await sessions.get(request.body.session_id);
      if (!session) return reply.code(404).send({ error: "discovery_session_not_found" });
      const evidenceId = randomUUID();
      const key = `evidence/${request.body.session_id}/${evidenceId}`;
      try {
        const signed = await options.objectStorage.createUploadUrl({
          key, contentType: request.body.content_type, sha256: request.body.sha256, expiresInSeconds: uploadTtl
        });
        return reply.code(201).send({
          evidence_id: evidenceId, method: "PUT", upload_url: signed.url,
          required_headers: signed.headers, storage_uri: `s3://${bucket}/${key}`,
          expires_in_seconds: uploadTtl
        });
      } catch (error) {
        request.log.error(error);
        return reply.code(502).send({ error: "evidence_upload_url_failed" });
      }
    }
  );

  app.post<{ Params: { evidenceId: string }; Body: Omit<CreateEvidenceArtifactInput, "storage_uri"> }>(
    "/v1/evidence-artifacts/:evidenceId/confirm", { schema: { body: evidenceUploadSchema } },
    async (request, reply) => {
      if (!options.objectStorage) return reply.code(501).send({ error: "object_storage_not_configured" });
      const session = await sessions.get(request.body.session_id);
      if (!session) return reply.code(404).send({ error: "discovery_session_not_found" });
      const key = `evidence/${request.body.session_id}/${request.params.evidenceId}`;
      try {
        const head = await options.objectStorage.headObject(key);
        if (!head) return reply.code(409).send({ error: "evidence_object_not_uploaded" });
        const expectedChecksum = Buffer.from(request.body.sha256, "hex").toString("base64");
        if (head.byteSize !== request.body.byte_size ||
            head.contentType !== request.body.content_type ||
            head.sha256 !== expectedChecksum) {
          return reply.code(422).send({ error: "evidence_object_metadata_mismatch" });
        }
        const artifact = await evidence.create({
          ...request.body, storage_uri: `s3://${bucket}/${key}`
        }, request.params.evidenceId);
        return reply.code(201).send(artifact);
      } catch (error) {
        if (error instanceof Error && error.message === "Evidence artifact already exists") {
          return reply.code(409).send({ error: "evidence_artifact_already_confirmed" });
        }
        request.log.error(error);
        return reply.code(502).send({ error: "evidence_upload_confirmation_failed" });
      }
    }
  );

  app.get<{ Params: { evidenceId: string } }>("/v1/evidence-artifacts/:evidenceId/download-url", async (request, reply) => {
    const access = await evidenceReadAuthorized(request.headers);
    if (access === "not_configured") return reply.code(503).send({ error: "evidence_read_auth_not_configured" });
    if (access === "denied") return reply.code(401).send({ error: "service_authentication_required" });
    if (!options.objectStorage) return reply.code(501).send({ error: "object_storage_not_configured" });
    const artifact = await evidence.get(request.params.evidenceId);
    if (!artifact) return reply.code(404).send({ error: "evidence_artifact_not_found" });
    const prefix = `s3://${bucket}/`;
    if (!artifact.storage_uri.startsWith(prefix)) return reply.code(409).send({ error: "unsupported_evidence_storage_uri" });
    const key = artifact.storage_uri.slice(prefix.length);
    try {
      const downloadUrl = await options.objectStorage.createDownloadUrl(key, downloadTtl);
      return { evidence_id: artifact.evidence_id, download_url: downloadUrl, expires_in_seconds: downloadTtl };
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({ error: "evidence_download_url_failed" });
    }
  });

  app.get<{ Params: { evidenceId: string } }>("/v1/evidence-artifacts/:evidenceId", async (request, reply) => {
    const access = await evidenceReadAuthorized(request.headers);
    if (access === "not_configured") return reply.code(503).send({ error: "evidence_read_auth_not_configured" });
    if (access === "denied") return reply.code(401).send({ error: "service_authentication_required" });
    const artifact = await evidence.get(request.params.evidenceId);
    if (!artifact) return reply.code(404).send({ error: "evidence_artifact_not_found" });
    return artifact;
  });
  app.get<{ Params: { sessionId: string } }>("/v1/discovery-sessions/:sessionId/evidence", async (request, reply) => {
    const access = await evidenceReadAuthorized(request.headers);
    if (access === "not_configured") return reply.code(503).send({ error: "evidence_read_auth_not_configured" });
    if (access === "denied") return reply.code(401).send({ error: "service_authentication_required" });
    const session = await sessions.get(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: "discovery_session_not_found" });
    return { session_id: request.params.sessionId, items: await evidence.listBySession(request.params.sessionId) };
  });
  return app;
}
