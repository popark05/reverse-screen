import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryDiscoveryEventStore } from "../src/domain/discovery-event.js";
import { InMemoryDiscoverySessionStore } from "../src/domain/discovery-session.js";
import { buildApp } from "../src/server/app.js";

test("observe endpoint runs adapter, persists events and completes the session", async () => {
  const sessions = new InMemoryDiscoverySessionStore();
  const events = new InMemoryDiscoveryEventStore();
  const app = buildApp({
    sessions,
    store: events,
    observer: {
      observe: async (session) => [{
        event_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40002",
        session_id: session.session_id,
        sequence: 1,
        event_type: "screen_observed",
        occurred_at: new Date().toISOString(),
        platform: "android",
        payload: { screen_key: "native:sample" }
      }]
    }
  });
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const sessionId = created.json().session_id;
  const observed = await app.inject({ method: "POST", url: `/v1/discovery-sessions/${sessionId}/observe` });
  assert.equal(observed.statusCode, 201);
  assert.equal(observed.json().session.status, "completed");
  assert.equal(observed.json().accepted_count, 1);
  const listed = await app.inject({ method: "GET", url: `/v1/discovery-sessions/${sessionId}/events` });
  assert.equal(listed.json().events.length, 1);
  await app.close();
});

test("observe endpoint fails clearly when no runtime observer is configured", async () => {
  const app = buildApp();
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "ios", target_id: "simulator" }
  });
  const response = await app.inject({ method: "POST", url: `/v1/discovery-sessions/${created.json().session_id}/observe` });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().error, "discovery_observer_not_configured");
  await app.close();
});
