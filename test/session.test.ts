import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/server/app.js";

test("discovery session follows valid lifecycle transitions", async () => {
  const app = buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/v1/discovery-sessions",
    payload: { application_id: "demo-app", platform: "android", target_id: "emulator-5554" }
  });
  assert.equal(created.statusCode, 201);
  const session = created.json();
  assert.equal(session.status, "created");

  const started = await app.inject({
    method: "POST",
    url: `/v1/discovery-sessions/${session.session_id}/transitions`,
    payload: { status: "running" }
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().status, "running");
  assert.ok(started.json().started_at);

  const completed = await app.inject({
    method: "POST",
    url: `/v1/discovery-sessions/${session.session_id}/transitions`,
    payload: { status: "completed" }
  });
  assert.equal(completed.statusCode, 200);
  assert.ok(completed.json().finished_at);
  await app.close();
});

test("terminal discovery session cannot be restarted", async () => {
  const app = buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/v1/discovery-sessions",
    payload: { application_id: "demo-app", platform: "web", target_id: "chromium" }
  });
  const id = created.json().session_id;
  await app.inject({ method: "POST", url: `/v1/discovery-sessions/${id}/transitions`, payload: { status: "running" } });
  await app.inject({ method: "POST", url: `/v1/discovery-sessions/${id}/transitions`, payload: { status: "completed" } });
  const restarted = await app.inject({ method: "POST", url: `/v1/discovery-sessions/${id}/transitions`, payload: { status: "running" } });
  assert.equal(restarted.statusCode, 409);
  await app.close();
});
