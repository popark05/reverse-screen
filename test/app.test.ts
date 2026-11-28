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
    observe: async (session: DiscoverySession) => {
      observeCount++;
      const screenId = "11111111-1111-4111-8111-111111111111";
      const stateId = "22222222-2222-4222-8222-222222222222";
      const screen = {
        event_id: `screen-event-${observeCount}`, session_id: session.session_id, sequence: 1,
        event_type: "screen_observed" as const, occurred_at: "2026-11-28T00:00:00.000Z",
        platform: session.platform, screen_id: observeCount === 1 ? screenId : "33333333-3333-4333-8333-333333333333",
        state_id: observeCount === 1 ? stateId : "44444444-4444-4444-8444-444444444444",
        payload: { context_type: "native" }
      };
      if (observeCount !== 1) return [screen];
      return [screen, {
        event_id: "candidate-event", session_id: session.session_id, sequence: 2,
        event_type: "action_candidate" as const, occurred_at: "2026-11-28T00:00:00.000Z",
        platform: session.platform, screen_id: screenId, state_id: stateId,
        payload: {
          context_type: "native", action: "fill", enabled: true,
          target_element_key: "native-element:email",
          locator_strategy: "label", locator_value: "Email"
        }
      }];
    },
    executeAction: async (session: DiscoverySession, request: DiscoveryActionRequest) => ({
      event_id: "action-event", session_id: session.session_id, sequence: 1,
      event_type: "action_executed" as const, occurred_at: "2026-11-28T00:00:01.000Z",
      platform: session.platform,
      ...(request.screen_id ? { screen_id: request.screen_id } : {}),
      ...(request.state_id ? { state_id: request.state_id } : {}),
      payload: { action: request.action, context_type: request.context_type, ...(request.target_element_key ? { target_element_key: request.target_element_key } : {}), value_redacted: request.action === "fill" }
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
    payload: { context_type: "native", action: "fill", locator_strategy: "label", locator_value: "Email", input_value: "secret@example.test", screen_id: "11111111-1111-4111-8111-111111111111", state_id: "22222222-2222-4222-8222-222222222222", target_element_key: "native-element:email" }
  });
  assert.equal(disabled.statusCode, 501);
  await app.close();
  observeCount = 0;

  const noPolicyApp = buildApp({ observer, allowMobileActions: true });
  const noPolicySession = await noPolicyApp.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const noPolicySessionId = noPolicySession.json().session_id;
  await noPolicyApp.inject({ method: "POST", url: `/v1/discovery-sessions/${noPolicySessionId}/observe` });
  const noPolicyResponse = await noPolicyApp.inject({
    method: "POST", url: `/v1/discovery-sessions/${noPolicySessionId}/actions`,
    payload: { context_type: "native", action: "tap", locator_strategy: "label", locator_value: "Continue", screen_id: "11111111-1111-4111-8111-111111111111", state_id: "22222222-2222-4222-8222-222222222222", target_element_key: "native-element:email" }
  });
  assert.equal(noPolicyResponse.statusCode, 403);
  await noPolicyApp.close();
  observeCount = 0;

  let authorize = false;
  const enabledApp = buildApp({
    observer,
    allowMobileActions: true,
    authorizeMobileAction: async ({ session, action, headers }) => {
      assert.equal(session.application_id, "sample-app");
      assert.equal(action.action, "fill");
      assert.equal("input_value" in action, false);
      assert.ok(headers);
      return authorize;
    }
  });
  const createdAgain = await enabledApp.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const enabledSessionId = createdAgain.json().session_id;
  await enabledApp.inject({ method: "POST", url: `/v1/discovery-sessions/${enabledSessionId}/observe` });
  const actionPayload = { context_type: "native", action: "fill", locator_strategy: "label", locator_value: "Email", input_value: "secret@example.test", screen_id: "11111111-1111-4111-8111-111111111111", state_id: "22222222-2222-4222-8222-222222222222", target_element_key: "native-element:email" };
  const denied = await enabledApp.inject({
    method: "POST", url: `/v1/discovery-sessions/${enabledSessionId}/actions`, payload: actionPayload
  });
  assert.equal(denied.statusCode, 403);
  authorize = true;
  const action = await enabledApp.inject({
    method: "POST", url: `/v1/discovery-sessions/${enabledSessionId}/actions`,
    payload: actionPayload
  });
  assert.equal(action.statusCode, 201);
  assert.equal(action.json().action.event_type, "action_executed");
  assert.equal(action.json().action.payload.value_redacted, true);
  assert.equal(action.json().action.payload.target_element_key, "native-element:email");
  assert.equal(action.json().action.screen_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(JSON.stringify(action.json()).includes("secret@example.test"), false);
  assert.deepEqual(action.json().observation_events.map((event: { sequence: number }) => event.sequence), [4]);
  const events = await enabledApp.inject({ method: "GET", url: `/v1/discovery-sessions/${enabledSessionId}/events` });
  assert.deepEqual(events.json().events.map((event: { sequence: number }) => event.sequence), [1, 2, 3, 4]);
  await enabledApp.close();
});
