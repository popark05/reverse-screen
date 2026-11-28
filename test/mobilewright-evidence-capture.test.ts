import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DiscoveryEvent } from "../src/domain/discovery-event.js";
import type { ObjectStorage } from "../src/infrastructure/object-storage.js";
import { buildApp } from "../src/server/app.js";

class RecordingStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; sha256: string }>();
  async createUploadUrl() { return { url: "https://unused.example.test/upload", headers: {} }; }
  async putObject(input: { key: string; body: Uint8Array; contentType: string; sha256: string }) {
    this.objects.set(input.key, { bytes: input.body, contentType: input.contentType, sha256: Buffer.from(input.sha256, "hex").toString("base64") });
  }
  async headObject(key: string) {
    const object = this.objects.get(key);
    if (!object) return undefined;
    return {
      byteSize: object.bytes.byteLength, contentType: object.contentType, sha256: object.sha256
    };
  }
  async createDownloadUrl(key: string) { return `https://storage.example.test/${key}`; }
}

test("discovery observation uploads captured screenshot and links evidence to screen event", async () => {
  const storage = new RecordingStorage();
  const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const screenEvent: DiscoveryEvent = {
    event_id: "a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0",
    session_id: "a0a0a0a0-1111-4111-8111-a0a0a0a0a0a0",
    sequence: 1, event_type: "screen_observed", occurred_at: "2026-11-27T00:00:00.000Z",
    platform: "android", payload: { context_type: "native" }
  };
  const observer = {
    async observe() { return [screenEvent]; },
    async observeWithEvidence() {
      return {
        events: [screenEvent],
        evidence: [{ kind: "screenshot" as const, content_type: "image/png", bytes: screenshot,
          captured_at: "2026-11-27T00:00:00.000Z", event_id: screenEvent.event_id }]
      };
    }
  };
  const serviceToken = "qa-platform-service-token-012345678901234567890123";
  const app = buildApp({ observer, objectStorage: storage, objectStorageBucket: "reverse-screen", authorizeEvidenceRead: ({ authorization }) => authorization === `Bearer ${serviceToken}` });
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "sample-app", platform: "android", target_id: "emulator-5554" }
  });
  const sessionId = created.json().session_id;
  screenEvent.session_id = sessionId;
  const response = await app.inject({ method: "POST", url: `/v1/discovery-sessions/${sessionId}/observe` });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().evidence_count, 1);
  const event = response.json().events[0];
  assert.equal(event.evidence_ids.length, 1);
  const listed = await app.inject({ method: "GET", url: `/v1/discovery-sessions/${sessionId}/evidence`, headers: { authorization: "Bearer qa-platform-service-token-012345678901234567890123" } });
  assert.equal(listed.json().items.length, 1);
  const artifact = listed.json().items[0];
  assert.equal(artifact.event_id, screenEvent.event_id);
  assert.equal(artifact.byte_size, screenshot.byteLength);
  assert.equal(artifact.sha256, createHash("sha256").update(screenshot).digest("hex"));
  assert.equal(storage.objects.size, 1);
  await app.close();
});
