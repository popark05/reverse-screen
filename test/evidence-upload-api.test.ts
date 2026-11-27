import assert from "node:assert/strict";
import test from "node:test";
import type { ObjectStorage } from "../src/infrastructure/object-storage.js";
import { buildApp } from "../src/server/app.js";

class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { byteSize: number; contentType: string; sha256: string }>();
  async createUploadUrl(input: { key: string; contentType: string; sha256: string }) {
    this.objects.set(input.key, { byteSize: 1234, contentType: input.contentType, sha256: Buffer.from(input.sha256, "hex").toString("base64") });
    return { url: `https://storage.example.test/${input.key}?signature=fake`, headers: { "content-type": input.contentType, "x-amz-checksum-sha256": Buffer.from(input.sha256, "hex").toString("base64") } };
  }
  async putObject(input: { key: string; body: Uint8Array; contentType: string; sha256: string }) {
    this.objects.set(input.key, { byteSize: input.body.byteLength, contentType: input.contentType, sha256: Buffer.from(input.sha256, "hex").toString("base64") });
  }
  async headObject(key: string) { return this.objects.get(key); }
  async createDownloadUrl(key: string) { return `https://storage.example.test/${key}?download=fake`; }
}

test("evidence upload is confirmed against object size, content type and SHA-256 before registration", async () => {
  const storage = new FakeObjectStorage();
  const app = buildApp({ objectStorage: storage, uploadUrlTtlSeconds: 240, downloadUrlTtlSeconds: 120 });
  const session = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const sessionId = session.json().session_id;
  const sha256 = "ab".repeat(32);
  const upload = await app.inject({
    method: "POST", url: "/v1/evidence-artifacts/upload-url",
    payload: { session_id: sessionId, kind: "screenshot", content_type: "image/png", byte_size: 1234, sha256, captured_at: "2026-11-27T00:00:00.000Z" }
  });
  assert.equal(upload.statusCode, 201);
  assert.equal(upload.json().method, "PUT");
  assert.ok(upload.json().upload_url.includes("signature=fake"));
  assert.equal(upload.json().required_headers["x-amz-checksum-sha256"], Buffer.from(sha256, "hex").toString("base64"));

  const evidenceId = upload.json().evidence_id;
  const confirmed = await app.inject({
    method: "POST", url: `/v1/evidence-artifacts/${evidenceId}/confirm`,
    payload: { session_id: sessionId, kind: "screenshot", content_type: "image/png", byte_size: 1234, sha256, captured_at: "2026-11-27T00:00:00.000Z" }
  });
  assert.equal(confirmed.statusCode, 201);
  assert.equal(confirmed.json().storage_uri, `s3://reverse-screen/evidence/${sessionId}/${evidenceId}`);

  const download = await app.inject({ method: "GET", url: `/v1/evidence-artifacts/${evidenceId}/download-url` });
  assert.equal(download.statusCode, 200);
  assert.ok(download.json().download_url.includes("download=fake"));
  await app.close();
});

test("evidence confirmation rejects missing or mismatched uploaded objects", async () => {
  const storage = new FakeObjectStorage();
  const app = buildApp({ objectStorage: storage });
  const session = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "web", target_id: "local-chromium" }
  });
  const sessionId = session.json().session_id;
  const sha256 = "cd".repeat(32);
  const upload = await app.inject({
    method: "POST", url: "/v1/evidence-artifacts/upload-url",
    payload: { session_id: sessionId, kind: "log", content_type: "text/plain", byte_size: 1234, sha256, captured_at: "2026-11-27T00:00:00.000Z" }
  });
  const evidenceId = upload.json().evidence_id;
  const key = `evidence/${sessionId}/${evidenceId}`;
  storage.objects.set(key, { byteSize: 10, contentType: "text/plain", sha256: Buffer.from(sha256, "hex").toString("base64") });
  const mismatch = await app.inject({
    method: "POST", url: `/v1/evidence-artifacts/${evidenceId}/confirm`,
    payload: { session_id: sessionId, kind: "log", content_type: "text/plain", byte_size: 1234, sha256, captured_at: "2026-11-27T00:00:00.000Z" }
  });
  assert.equal(mismatch.statusCode, 422);
  const missing = await app.inject({
    method: "POST", url: "/v1/evidence-artifacts/00000000-0000-4000-8000-000000000000/confirm",
    payload: { session_id: sessionId, kind: "log", content_type: "text/plain", byte_size: 1234, sha256, captured_at: "2026-11-27T00:00:00.000Z" }
  });
  assert.equal(missing.statusCode, 409);
  await app.close();
});
