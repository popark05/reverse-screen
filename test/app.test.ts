import assert from "node:assert/strict";
import test from "node:test";
import { createMockDiscoveryEvents } from "../src/adapters/mock-adapter.js";
import { buildApp } from "../src/server/app.js";
import type { DiscoverySession } from "../src/domain/discovery-session.js";
import type { DiscoveryActionRequest } from "../src/domain/discovery-action.js";

const sessionId = "b6a3f8e4-4a1d-4c0d-9e1a-1e5e6c7d8f90";

test("health endpoint reports service status", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", service: "reverse-screen" });
  await app.close();
});

test("contract-compatible discovery events can be ingested and queried by session", async () => {
  const app = buildApp();
  const event = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId,
    targetId: "android-emulator",
    platform: "android"
  })[0]!;

  const accepted = await app.inject({
    method: "POST",
    url: "/v1/discovery-events",
    payload: event
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.json().duplicate, false);

  const queried = await app.inject({
    method: "GET",
    url: `/v1/discovery-sessions/${sessionId}/events`
  });
  assert.equal(queried.statusCode, 200);
  assert.equal(queried.json().events.length, 1);
  await app.close();
});

test("event ingestion is idempotent by event_id", async () => {
  const app = buildApp();
  const event = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId,
    targetId: "web-chrome",
    platform: "web"
  })[0]!;
  const send = () => app.inject({ method: "POST", url: "/v1/discovery-events", payload: event });

  assert.equal((await send()).statusCode, 202);
  const duplicate = await send();
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().duplicate, true);
  await app.close();
});

test("invalid platform and malformed identifiers are rejected", async () => {
  const app = buildApp();
  const event = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId,
    targetId: "unknown",
    platform: "ios"
  })[0]!;
  const response = await app.inject({
    method: "POST",
    url: "/v1/discovery-events",
    payload: { ...event, platform: "windows" }
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});


test("mobile action execution is opt-in and appends action plus post-action observation events", async () => {
  let observeCount = 0;
  const observer = {
    observe: async (session: DiscoverySession) => [{
      event_id: `event-${++observeCount}`, session_id: session.session_id, sequence: 1,
      event_type: "screen_observed" as const, occurred_at: "2026-11-28T00:00:00.000Z",
      platform: session.platform, payload: { context_type: "native" }
    }],
    executeAction: async (session: DiscoverySession, request: DiscoveryActionRequest) => ({
      event_id: "action-event", session_id: session.session_id, sequence: 1,
      event_type: "action_executed" as const, occurred_at: "2026-11-28T00:00:01.000Z",
      platform: session.platform,
      payload: { action: request.action, context_type: request.context_type, value_redacted: request.action === "fill" }
    })
  };
  const app = buildApp({ observer });
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const sessionId = created.json().session_id;
  const observed = await app.inject({ method: "POST", url: `/v1/discovery-sessions/${sessionId}/observe` });
  assert.equal(observed.statusCode, 201);

  const disabled = await app.inject({
    method: "POST", url: `/v1/discovery-sessions/${sessionId}/actions`,
    payload: { context_type: "native", action: "fill", locator_strategy: "label", locator_value: "Email", input_value: "secret@example.test" }
  });
  assert.equal(disabled.statusCode, 501);
  await app.close();

  const enabledApp = buildApp({ observer, allowMobileActions: true });
  const createdAgain = await enabledApp.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const enabledSessionId = createdAgain.json().session_id;
  await enabledApp.inject({ method: "POST", url: `/v1/discovery-sessions/${enabledSessionId}/observe` });
  const action = await enabledApp.inject({
    method: "POST", url: `/v1/discovery-sessions/${enabledSessionId}/actions`,
    payload: { context_type: "native", action: "fill", locator_strategy: "label", locator_value: "Email", input_value: "secret@example.test" }
  });
  assert.equal(action.statusCode, 201);
  assert.equal(action.json().action.event_type, "action_executed");
  assert.equal(action.json().action.payload.value_redacted, true);
  assert.equal(JSON.stringify(action.json()).includes("secret@example.test"), false);
  assert.deepEqual(action.json().observation_events.map((event: { sequence: number }) => event.sequence), [3]);
  const events = await enabledApp.inject({ method: "GET", url: `/v1/discovery-sessions/${enabledSessionId}/events` });
  assert.deepEqual(events.json().events.map((event: { sequence: number }) => event.sequence), [1, 2, 3]);
  await enabledApp.close();
});
