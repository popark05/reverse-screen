import assert from "node:assert/strict";
import test from "node:test";
import { createMockDiscoveryEvents } from "../src/adapters/mock-adapter.js";
import { buildApp } from "../src/server/app.js";

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
  const [event] = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId,
    targetId: "android-emulator",
    platform: "android"
  });

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
  const [event] = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId,
    targetId: "web-chrome",
    platform: "web"
  });
  const send = () => app.inject({ method: "POST", url: "/v1/discovery-events", payload: event });

  assert.equal((await send()).statusCode, 202);
  const duplicate = await send();
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().duplicate, true);
  await app.close();
});

test("invalid platform and malformed identifiers are rejected", async () => {
  const app = buildApp();
  const [event] = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId,
    targetId: "unknown",
    platform: "ios"
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/discovery-events",
    payload: { ...event, platform: "windows" }
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});
