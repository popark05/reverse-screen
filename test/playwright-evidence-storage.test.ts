import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DiscoveryEvent } from "../src/domain/discovery-event.js";
import type { CapturedEvidence } from "../src/domain/evidence-artifact.js";
import type { ObjectStorage } from "../src/infrastructure/object-storage.js";
import { buildApp } from "../src/server/app.js";

class RecordingStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; sha256: string }>();

  async createUploadUrl() { return { url: "https://unused.example.test/upload", headers: {} }; }
  async putObject(input: { key: string; body: Uint8Array; contentType: string; sha256: string }) {
    this.objects.set(input.key, {
      bytes: input.body,
      contentType: input.contentType,
      sha256: Buffer.from(input.sha256, "hex").toString("base64")
    });
  }
  async headObject(key: string) {
    const object = this.objects.get(key);
    if (!object) return undefined;
    return {
      byteSize: object.bytes.byteLength,
      contentType: object.contentType,
      sha256: object.sha256
    };
  }
  async createDownloadUrl(key: string) { return `https://storage.example.test/${key}`; }
}

test("web discovery persists screenshot, DOM snapshot, and accessibility tree artifacts", async () => {
  const storage = new RecordingStorage();
  const screenEvent: DiscoveryEvent = {
    event_id: "b0b0b0b0-1111-4111-8111-b0b0b0b0b0b0",
    session_id: "b0b0b0b0-1111-4111-8111-b0b0b0b0b0b0",
    sequence: 1,
    event_type: "screen_observed",
    occurred_at: "2026-11-28T00:00:00.000Z",
    platform: "web",
    payload: { context_type: "web" }
  };
  const captured: CapturedEvidence[] = [
    {
      kind: "screenshot", content_type: "image/png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), captured_at: screenEvent.occurred_at,
      event_id: screenEvent.event_id
    },
    {
      kind: "dom_snapshot", content_type: "text/html; charset=utf-8",
      bytes: Buffer.from("<main>[REDACTED]</main>", "utf8"), captured_at: screenEvent.occurred_at,
      event_id: screenEvent.event_id
    },
    {
      kind: "accessibility_tree", content_type: "application/json",
      bytes: Buffer.from(JSON.stringify({ role: "main", children: [] }), "utf8"),
      captured_at: screenEvent.occurred_at, event_id: screenEvent.event_id
    }
  ];
  const observer = {
    async observe() { return [screenEvent]; },
    async observeWithEvidence() {
      return { events: [screenEvent], evidence: captured };
    }
  };
  const app = buildApp({
    observer,
    objectStorage: storage,
    objectStorageBucket: "reverse-screen"
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/discovery-sessions",
    payload: { application_id: "sample-web-app", platform: "web", target_id: "chromium" }
  });
  const sessionId = created.json().session_id as string;
  screenEvent.session_id = sessionId;

  const observed = await app.inject({
    method: "POST",
    url: `/v1/discovery-sessions/${sessionId}/observe`
  });
  assert.equal(observed.statusCode, 201);
  assert.equal(observed.json().evidence_count, 3);
  assert.equal(observed.json().events[0].evidence_ids.length, 3);

  const listed = await app.inject({
    method: "GET",
    url: `/v1/discovery-sessions/${sessionId}/evidence`
  });
  const artifacts = listed.json().items as Array<{
    evidence_id: string; kind: string; content_type: string; byte_size: number; sha256: string; event_id: string;
  }>;
  assert.equal(artifacts.length, 3);
  assert.deepEqual(artifacts.map((item) => item.kind).sort(), [
    "accessibility_tree", "dom_snapshot", "screenshot"
  ]);
  assert.equal(artifacts.every((item) => item.event_id === screenEvent.event_id), true);
  assert.equal(storage.objects.size, 3);

  for (const artifact of artifacts) {
    const key = `evidence/${sessionId}/${artifact.evidence_id}`;
    const stored = storage.objects.get(key);
    assert.ok(stored);
    assert.equal(stored.contentType, artifact.content_type);
    assert.equal(stored.bytes.byteLength, artifact.byte_size);
    assert.equal(artifact.sha256, createHash("sha256").update(stored.bytes).digest("hex"));
  }

  await app.close();
});
