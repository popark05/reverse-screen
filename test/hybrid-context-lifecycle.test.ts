import assert from "node:assert/strict";
import test from "node:test";
import { HybridContextLifecycleTracker } from "../src/domain/hybrid-context-lifecycle.js";

const context = (contextKey: string, screenId: string) => ({
  contextKey, screenId, stateId: `state-${screenId}`, webViewIndex: 0,
  url: "https://example.test/checkout", title: "Checkout"
});

test("tracks attachment, persistence, detachment and reattachment across complete observations", () => {
  const tracker = new HybridContextLifecycleTracker();
  const first = tracker.reconcile("session-1", "2026-11-28T00:00:00.000Z", [context("web-1", "screen-1")]);
  assert.equal(first.observationNumber, 1);
  assert.equal(first.active.length, 1);
  assert.equal(first.active[0]?.isNew, true);
  assert.equal(first.active[0]?.lifecycle.observationCount, 1);

  const second = tracker.reconcile("session-1", "2026-11-28T00:00:05.000Z", [context("web-1", "screen-2")]);
  assert.equal(second.observationNumber, 2);
  assert.equal(second.active[0]?.isNew, false);
  assert.equal(second.active[0]?.lifecycle.transitionId, first.active[0]?.lifecycle.transitionId);
  assert.equal(second.active[0]?.lifecycle.observationCount, 2);
  assert.equal(second.active[0]?.lifecycle.firstSeenAt, "2026-11-28T00:00:00.000Z");

  const third = tracker.reconcile("session-1", "2026-11-28T00:00:10.000Z", []);
  assert.equal(third.detached.length, 1);
  assert.equal(third.detached[0]?.context.screenId, "screen-2");
  assert.equal(third.detached[0]?.lifecycle.transitionId, first.active[0]?.lifecycle.transitionId);
  assert.equal(third.detached[0]?.lifecycle.observationCount, 2);

  const fourth = tracker.reconcile("session-1", "2026-11-28T00:00:15.000Z", []);
  assert.equal(fourth.detached.length, 0);

  const fifth = tracker.reconcile("session-1", "2026-11-28T00:00:20.000Z", [context("web-1", "screen-5")]);
  assert.equal(fifth.active[0]?.isNew, true);
  assert.notEqual(fifth.active[0]?.lifecycle.transitionId, first.active[0]?.lifecycle.transitionId);
  assert.equal(fifth.active[0]?.lifecycle.observationCount, 1);
});

test("keeps lifecycle state isolated by discovery session", () => {
  const tracker = new HybridContextLifecycleTracker();
  tracker.reconcile("session-a", "2026-11-28T00:00:00.000Z", [context("web-1", "screen-a")]);
  const other = tracker.reconcile("session-b", "2026-11-28T00:00:01.000Z", []);
  assert.equal(other.observationNumber, 1);
  assert.equal(other.detached.length, 0);
});
