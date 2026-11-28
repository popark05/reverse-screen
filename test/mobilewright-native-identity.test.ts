import assert from "node:assert/strict";
import test from "node:test";
import { MobilewrightDiscoveryAdapter, excludeForeignWindows, inferScreenName } from "../src/adapters/mobilewright-discovery-adapter.js";
import type { DiscoveryActionRequest } from "../src/domain/discovery-action.js";
import type { DiscoveryEvent } from "../src/domain/discovery-event.js";
import type { DiscoverySession } from "../src/domain/discovery-session.js";
import { buildApp } from "../src/server/app.js";

// Shapes below mirror a real Now in Android (Jetpack Compose) tree captured on a Samsung device.
type Node = {
  type: string; label?: string; text?: string; identifier?: string; isVisible: boolean; isEnabled: boolean;
  isChecked?: boolean; bounds: { x: number; y: number; width: number; height: number }; children: Node[];
  raw?: Record<string, unknown>;
};
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const node = (type: string, bounds: Node["bounds"], extra: Partial<Node> = {}, children: Node[] = []): Node =>
  ({ type, isVisible: true, isEnabled: true, bounds, children, ...extra });
const clickable = { raw: { clickable: true } };

const edgePanel = node("android.widget.FrameLayout", box(0, 328, 67, 326), { raw: { paneTitle: "Edge" } }, [
  node("android.widget.RelativeLayout", box(0, 328, 67, 326), {
    label: "Edge 패널", identifier: "com.samsung.android.app.cocktailbarservice:id/trigger_layout_container"
  })
]);
const bottomBar = (selected: string) => ["For you", "Saved", "Interests"].map((tab, index) =>
  tab === selected
    ? node("android.widget.TextView", box(105 + index * 360, 2175, 133, 46), { text: tab })
    : node("android.view.View", box(index * 360, 2040, 345, 225), clickable, [
        node("android.widget.TextView", box(105 + index * 360, 2175, 133, 46), { text: tab })
      ]));
const homeRoot = (followHint: string) => node("android.widget.FrameLayout", box(0, 0, 1080, 2400), { identifier: "android:id/content" }, [
  node("android.view.View", box(0, 0, 1080, 272), { identifier: "niaTopAppBar" }, [
    node("android.view.View", box(11, 114, 135, 135), clickable, [node("android.view.View", box(45, 148, 68, 68), { label: "Search" })]),
    node("android.widget.TextView", box(323, 140, 435, 83), { text: "Now in Android" }),
    node("android.view.View", box(934, 114, 135, 135), clickable, [node("android.view.View", box(968, 148, 68, 68), { label: "Settings" })])
  ]),
  node("android.view.View", box(0, 272, 1080, 1283), { identifier: "forYou:feed" }, [
    node("android.widget.TextView", box(0, 471, 1080, 115), { text: followHint }),
    // Topic row: clickable card whose follow button is separately actionable.
    node("android.view.View", box(68, 654, 878, 157), clickable, [
      node("android.widget.TextView", box(282, 707, 472, 52), { text: "Headlines" }),
      node("android.view.View", box(788, 665, 135, 135), clickable, [node("android.view.View", box(822, 699, 68, 68), { label: "Headlines" })])
    ]),
    // Two unnamed clickable cards with identical captions are ambiguous and must not become candidates.
    node("android.view.View", box(68, 845, 400, 100), clickable, [node("android.widget.TextView", box(80, 860, 100, 40), { text: "More" })]),
    node("android.view.View", box(568, 845, 400, 100), clickable, [node("android.widget.TextView", box(580, 860, 100, 40), { text: "More" })])
  ]),
  ...bottomBar("For you")
]);
const settingsDialog = node("android.widget.FrameLayout", box(0, 124, 1080, 2108), { identifier: "android:id/content" }, [
  node("android.widget.TextView", box(67, 192, 300, 83), { text: "Settings" }),
  node("android.view.View", box(67, 451, 900, 136), { ...clickable, isChecked: true }, [
    node("android.widget.TextView", box(230, 488, 200, 63), { text: "Default" })
  ]),
  node("android.view.View", box(800, 2040, 200, 100), clickable, [node("android.widget.TextView", box(850, 2068, 60, 57), { text: "OK" })])
]);

const session: DiscoverySession = {
  session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001", application_id: "now-in-android",
  platform: "android", target_id: "R3CR10LXLZW", status: "completed",
  created_at: "2026-11-28T00:00:00.000Z", updated_at: "2026-11-28T00:00:00.000Z"
};
const bundleId = "com.google.samples.apps.nowinandroid.demo.debug";

function fakeDevice(tree: () => Node[], calls: string[] = []) {
  const locator = { tap: async () => { calls.push("tap"); }, fill: async () => {} };
  return {
    id: "R3CR10LXLZW",
    screen: {
      viewTree: async () => tree(),
      getByWebView: () => ({ count: async () => 0, page: async () => { throw new Error("no webview"); } }),
      getByRole: (role: string, options?: { name?: string }) => { calls.push(`role:${role}:${options?.name}`); return locator; },
      getByLabel: (label: string) => { calls.push(`label:${label}`); return locator; },
      getByTestId: (id: string) => { calls.push(`test-id:${id}`); return locator; },
      goBack: async () => { calls.push("go-back"); },
      screenshot: async () => Buffer.from("png")
    },
    getForegroundApp: async () => ({ bundleId, name: "Now in Android" }),
    screenSize: async () => ({ width: 1080, height: 2400, scale: 1 }),
    close: async () => { calls.push("device-close"); }
  };
}
function adapterFor(device: ReturnType<typeof fakeDevice>) {
  return new MobilewrightDiscoveryAdapter({ bundleId }, {
    ios: { launch: async () => device as never }, android: { launch: async () => device as never }
  });
}
const screenOf = (events: DiscoveryEvent[]) => events.find((event) => event.event_type === "screen_observed")!;
const candidates = (events: DiscoveryEvent[]) => events.filter((event) => event.event_type === "action_candidate").map((event) => event.payload);

test("foreign overlay windows are excluded from elements, candidates and identity", async () => {
  const withOverlay = await adapterFor(fakeDevice(() => [edgePanel, homeRoot("Follow topics")])).observe(session);
  const withoutOverlay = await adapterFor(fakeDevice(() => [homeRoot("Follow topics")])).observe(session);
  assert.equal(screenOf(withOverlay).payload.excluded_foreign_window_count, 1);
  assert.equal(JSON.stringify(withOverlay).includes("cocktailbarservice"), false);
  assert.equal(screenOf(withOverlay).screen_id, screenOf(withoutOverlay).screen_id, "overlay presence must not change identity");
  assert.equal(screenOf(withOverlay).state_id, screenOf(withoutOverlay).state_id);
});

test("revisits keep screen and state IDs; text changes only change the state", async () => {
  let hint = "Follow topics";
  const adapter = adapterFor(fakeDevice(() => [edgePanel, homeRoot(hint)]));
  const first = screenOf(await adapter.observe(session));
  const revisit = screenOf(await adapter.observe(session));
  hint = "Your feed is ready";
  const changed = screenOf(await adapter.observe(session));
  const dialog = screenOf(await adapterFor(fakeDevice(() => [settingsDialog])).observe(session));

  assert.equal(revisit.screen_id, first.screen_id);
  assert.equal(revisit.state_id, first.state_id);
  assert.equal(changed.screen_id, first.screen_id);
  assert.notEqual(changed.state_id, first.state_id);
  assert.notEqual(dialog.screen_id, first.screen_id);
  assert.match(first.screen_id!, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("screens are named from their header text instead of the application name", async () => {
  const home = screenOf(await adapterFor(fakeDevice(() => [edgePanel, homeRoot("Follow topics")])).observe(session));
  const dialog = screenOf(await adapterFor(fakeDevice(() => [settingsDialog])).observe(session));
  assert.equal(home.payload.name, "Now in Android");
  assert.equal(home.payload.name_source, "header_text");
  assert.equal(home.payload.app_name, "Now in Android");
  assert.equal(dialog.payload.name, "Settings");
  assert.equal(inferScreenName([]), undefined);
  assert.deepEqual(excludeForeignWindows([edgePanel as never], bundleId), []);
});

test("clickable Compose containers named by child text become unique button candidates", async () => {
  const home = candidates(await adapterFor(fakeDevice(() => [homeRoot("Follow topics")])).observe(session));
  const saved = home.find((candidate) => candidate.locator_name === "Saved");
  assert.deepEqual(
    { strategy: saved?.locator_strategy, role: saved?.locator_role, source: saved?.locator_source, action: saved?.action },
    { strategy: "role_name", role: "button", source: "descendant_text", action: "tap" }
  );
  assert.ok(home.some((candidate) => candidate.locator_name === "Interests"));
  assert.equal(home.some((candidate) => candidate.locator_name === "More"), false, "ambiguous names are skipped");
  assert.equal(home.some((candidate) => candidate.locator_name === "Headlines Headlines"), false, "rows with actionable children are skipped");
  assert.ok(home.some((candidate) => candidate.locator_value === "Headlines"), "the labelled follow button stays a candidate");

  const dialog = candidates(await adapterFor(fakeDevice(() => [settingsDialog])).observe(session));
  assert.ok(dialog.some((candidate) => candidate.locator_name === "OK"));
  assert.ok(dialog.some((candidate) => candidate.locator_name === "Default"));
});

test("back action navigates without a locator and records a deterministic transition", async () => {
  let tree: Node[] = [settingsDialog];
  const calls: string[] = [];
  const adapter = adapterFor(fakeDevice(() => tree, calls));
  const observer = {
    observe: (s: DiscoverySession) => adapter.observe(s),
    executeAction: async (s: DiscoverySession, request: DiscoveryActionRequest) => {
      const event = await adapter.executeAction(s, request);
      tree = [homeRoot("Follow topics")];
      return event;
    }
  };
  const app = buildApp({ observer, allowMobileActions: true, authorizeMobileAction: async ({ action }) => action.action !== "fill" });
  const created = await app.inject({
    method: "POST", url: "/v1/discovery-sessions",
    payload: { application_id: "now-in-android", platform: "android", target_id: "R3CR10LXLZW" }
  });
  const sessionId = created.json().session_id;
  const observed = await app.inject({ method: "POST", url: `/v1/discovery-sessions/${sessionId}/observe` });
  const dialog = observed.json().events.find((event: DiscoveryEvent) => event.event_type === "screen_observed");

  const rejected = await app.inject({
    method: "POST", url: `/v1/discovery-sessions/${sessionId}/actions`,
    payload: { context_type: "webview", action: "back", screen_id: dialog.screen_id, state_id: dialog.state_id }
  });
  assert.equal(rejected.statusCode, 400);

  const back = await app.inject({
    method: "POST", url: `/v1/discovery-sessions/${sessionId}/actions`,
    payload: { context_type: "native", action: "back", screen_id: dialog.screen_id, state_id: dialog.state_id }
  });
  assert.equal(back.statusCode, 201, back.body);
  assert.ok(calls.includes("go-back"));
  const transition = back.json().transition;
  assert.equal(transition.payload.action, "back");
  assert.equal(transition.payload.transition_kind, "navigation");
  assert.equal(transition.payload.source_screen_id, dialog.screen_id);
  assert.equal(transition.payload.target_screen_name, "Now in Android");

  const stale = await app.inject({
    method: "POST", url: `/v1/discovery-sessions/${sessionId}/actions`,
    payload: { context_type: "native", action: "back", screen_id: dialog.screen_id, state_id: dialog.state_id }
  });
  assert.equal(stale.statusCode, 409, "back from a state that is no longer current is stale");
  await app.close();
});
