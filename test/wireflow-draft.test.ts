import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveryEvent } from "../src/domain/discovery-event.js";
import type { DiscoverySession } from "../src/domain/discovery-session.js";
import { buildWireflowDraft } from "../src/domain/wireflow-draft.js";
import { buildApp } from "../src/server/app.js";

const session: DiscoverySession = {
  session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001", application_id: "now-in-android",
  platform: "android", target_id: "R3CR10LXLZW", status: "completed",
  created_at: "2026-11-28T00:00:00.000Z", updated_at: "2026-11-28T00:00:00.000Z"
};
const HOME = "11111111-1111-8111-8111-111111111111";
const SEARCH = "22222222-2222-8222-8222-222222222222";
const WEB = "33333333-3333-4333-8333-333333333333";
const T_SEARCH = "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa";
const T_BACK = "bbbbbbbb-bbbb-8bbb-8bbb-bbbbbbbbbbbb";
const T_NOOP = "cccccccc-cccc-8ccc-8ccc-cccccccccccc";
const T_HYBRID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let sequence = 0;
const event = (event_type: DiscoveryEvent["event_type"], extra: Partial<DiscoveryEvent>, payload: Record<string, unknown>): DiscoveryEvent => ({
  event_id: `e-${++sequence}`, session_id: session.session_id, sequence, event_type,
  occurred_at: "2026-11-28T00:00:00.000Z", platform: "android", ...extra, payload
});
const screen = (screen_id: string, name: string, context_type = "native") =>
  event("screen_observed", { screen_id, state_id: screen_id }, { context_type, name });
const transition = (transition_id: string, from: string, to: string, kind: string, action: Record<string, unknown>) =>
  event("transition_observed", { screen_id: from, state_id: from, transition_id }, {
    transition_kind: kind, source_screen_id: from, target_screen_id: to, ...action
  });

function discoveredEvents(): DiscoveryEvent[] {
  sequence = 0;
  return [
    screen(HOME, "Now in Android"),
    screen(WEB, "Embedded page", "webview"),
    transition(T_HYBRID, HOME, WEB, "context_attachment", {}),
    screen(SEARCH, "Recent searches"),
    transition(T_SEARCH, HOME, SEARCH, "navigation", { action: "tap", locator_value: "Search" }),
    transition(T_NOOP, SEARCH, SEARCH, "no_change", { action: "back" }),
    screen(HOME, "Now in Android (renamed later)"),
    transition(T_BACK, SEARCH, HOME, "navigation", { action: "back" }),
    transition(T_SEARCH, HOME, SEARCH, "navigation", { action: "tap", locator_value: "Search" })
  ];
}

test("builds a wireflow import body from screens and action-driven transitions", () => {
  const draft = buildWireflowDraft(session, discoveredEvents());
  assert.ok(draft);
  assert.equal(draft.applicationId, "now-in-android");
  assert.deepEqual(draft.nodes.map((node) => [node.nodeId, node.title]), [[HOME, "Now in Android"], [SEARCH, "Recent searches"]],
    "one node per screen, titled by its first observed name; unreferenced WebView screens are skipped");
  assert.deepEqual(draft.nodes[0]?.discoveryRef, { sourceSystem: "reverse-screen", screenId: HOME, sessionId: session.session_id });
  assert.ok([...draft.nodes, ...draft.edges].every((item) => item.origin === "discovered"), "runtime observations are marked discovered");

  assert.deepEqual(draft.edges.map((edge) => [edge.fromNodeId, edge.label, edge.kind, edge.toNodeId]), [
    [HOME, "Search", "primary", SEARCH],
    [SEARCH, "Back", "back", HOME]
  ], "repeated transitions collapse; no_change and hybrid lifecycle transitions are not edges");
  assert.equal(draft.edges[0]?.edgeId, `transition-${T_SEARCH}`);
  assert.equal(draft.edges[0]?.discoveryRef.transitionId, T_SEARCH);
  assert.equal(draft.edges[1]?.trigger, "back");
});

test("returns nothing for a session without observed screens", () => {
  assert.equal(buildWireflowDraft(session, []), undefined);
});

test("wireflow-draft endpoint returns the draft, 404 for unknown sessions and 409 without screens", async () => {
  const app = buildApp();
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "now-in-android", platform: "android", target_id: "R3CR10LXLZW" }
  });
  const sessionId: string = created.json().session_id;

  const empty = await app.inject({ method: "GET", url: `/v1/discovery-sessions/${sessionId}/wireflow-draft` });
  assert.equal(empty.statusCode, 409);
  assert.equal(empty.json().error, "no_screens_observed");

  for (const item of discoveredEvents()) {
    const response = await app.inject({
      method: "POST", url: "/v1/discovery-events",
      payload: { ...item, event_id: crypto.randomUUID(), session_id: sessionId }
    });
    assert.equal(response.statusCode, 202, response.body);
  }
  const draft = await app.inject({ method: "GET", url: `/v1/discovery-sessions/${sessionId}/wireflow-draft` });
  assert.equal(draft.statusCode, 200);
  assert.equal(draft.json().nodes.length, 2);
  assert.equal(draft.json().edges.length, 2);
  assert.equal(draft.json().nodes[0].discoveryRef.sessionId, sessionId);

  const missing = await app.inject({ method: "GET", url: "/v1/discovery-sessions/00000000-0000-4000-8000-000000000000/wireflow-draft" });
  assert.equal(missing.statusCode, 404);
  await app.close();
});
