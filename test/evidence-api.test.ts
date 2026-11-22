import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/server/app.js";

test("evidence artifact metadata can be registered and queried by ID and session", async () => {
  const app = buildApp();
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const sessionId = created.json().session_id;
  const response = await app.inject({
    method: "POST", url: "/v1/evidence-artifacts",
    payload: {
      session_id: sessionId, kind: "screenshot", content_type: "image/png",
      byte_size: 1024, sha256: "a".repeat(64),
      storage_uri: "s3://reverse-screen/evidence/sample.png",
      captured_at: "2026-11-22T00:00:00.000Z"
    }
  });
  assert.equal(response.statusCode, 201);
  const evidenceId = response.json().evidence_id;
  const get = await app.inject({ method: "GET", url: `/v1/evidence-artifacts/${evidenceId}` });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().storage_uri, "s3://reverse-screen/evidence/sample.png");
  const list = await app.inject({ method: "GET", url: `/v1/discovery-sessions/${sessionId}/evidence` });
  assert.equal(list.json().items.length, 1);
  await app.close();
});

test("evidence metadata validates checksums, storage URI and session ownership", async () => {
  const app = buildApp();
  const invalid = await app.inject({
    method: "POST", url: "/v1/evidence-artifacts",
    payload: {
      session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001", kind: "screenshot",
      content_type: "image/png", byte_size: 20, sha256: "bad",
      storage_uri: "relative/path", captured_at: "2026-11-22T00:00:00.000Z"
    }
  });
  assert.equal(invalid.statusCode, 400);
  const missingSession = await app.inject({
    method: "POST", url: "/v1/evidence-artifacts",
    payload: {
      session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001", kind: "screenshot",
      content_type: "image/png", byte_size: 20, sha256: "a".repeat(64),
      storage_uri: "s3://bucket/object", captured_at: "2026-11-22T00:00:00.000Z"
    }
  });
  assert.equal(missingSession.statusCode, 404);
  await app.close();
});
