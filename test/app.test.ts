import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/server/app.js";
import { createMockDiscoveryEvents } from "../src/adapters/mock-adapter.js";

test("health endpoint reports service status", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", service: "reverse-screen" });
  await app.close();
});

test("discovery events can be ingested and queried by session", async () => {
  const app = buildApp();
  const event = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId: "session-1",
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
    url: "/v1/discovery-sessions/session-1/events"
  });
  assert.equal(queried.statusCode, 200);
  assert.equal(queried.json().events.length, 1);
  await app.close();
});

test("event ingestion is idempotent by eventId", async () => {
  const app = buildApp();
  const event = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId: "session-2",
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

test("invalid platform is rejected by request validation", async () => {
  const app = buildApp();
  const event = createMockDiscoveryEvents({
    applicationId: "demo-app",
    sessionId: "session-3",
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
