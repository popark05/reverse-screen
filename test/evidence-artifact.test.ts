import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEvidenceArtifactStore } from "../src/domain/evidence-artifact.js";

test("evidence metadata is assigned an ID and can be listed by discovery session", async () => {
  const store = new InMemoryEvidenceArtifactStore();
  const item = await store.create({
    session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001",
    kind: "screenshot", content_type: "image/png", byte_size: 1024,
    sha256: "a".repeat(64), storage_uri: "s3://reverse-screen/evidence/shot.png",
    captured_at: "2026-11-22T00:00:00.000Z"
  });
  assert.ok(item.evidence_id);
  assert.equal((await store.get(item.evidence_id))?.kind, "screenshot");
  assert.equal((await store.listBySession(item.session_id)).length, 1);
});
