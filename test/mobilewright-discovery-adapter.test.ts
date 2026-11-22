import assert from "node:assert/strict";
import test from "node:test";
import { MobilewrightDiscoveryAdapter } from "../src/adapters/mobilewright-discovery-adapter.js";
import type { DiscoverySession } from "../src/domain/discovery-session.js";

const session: DiscoverySession = {
  session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001",
  application_id: "sample-app",
  platform: "android",
  target_id: "emulator-5554",
  status: "running",
  created_at: "2026-11-22T00:00:00.000Z",
  updated_at: "2026-11-22T00:00:00.000Z"
};

test("Mobilewright discovery emits ordered screen, element and action candidate events", async () => {
  const calls: string[] = [];
  const device = {
    id: "emulator-5554",
    screen: {
      viewTree: async () => [
        {
          type: "Button", label: "Continue", identifier: "continue",
          isVisible: true, isEnabled: true, bounds: { x: 0, y: 0, width: 120, height: 48 }, children: []
        },
        {
          type: "EditText", label: "Email", text: "sensitive@example.test", placeholder: "Email",
          isVisible: true, isEnabled: true, bounds: { x: 0, y: 60, width: 200, height: 48 }, children: []
        }
      ]
    },
    getForegroundApp: async () => ({ bundleId: "com.example.app", name: "Example", version: "1.0" }),
    screenSize: async () => ({ width: 1080, height: 2400, scale: 3 }),
    close: async () => { calls.push("close"); }
  };
  const adapter = new MobilewrightDiscoveryAdapter({
    bundleId: "com.example.app",
    maxElements: 10
  }, {
    ios: { launch: async () => device },
    android: { launch: async (options) => { calls.push(`launch:${options.deviceId}:${options.bundleId}`); return device; } }
  });

  const events = await adapter.observe(session);
  assert.equal(events[0]?.event_type, "screen_observed");
  assert.equal(events[0]?.platform, "android");
  assert.equal(events.filter((event) => event.event_type === "element_observed").length, 2);
  assert.equal(events.filter((event) => event.event_type === "action_candidate").length, 2);
  const continueButton = events.find((event) => event.event_type === "element_observed" && event.payload.accessible_name === "Continue");
  assert.equal(continueButton?.payload.role, "button");
  const email = events.find((event) => event.event_type === "element_observed" && event.payload.element_type === "EditText");
  assert.equal(email?.payload.text, undefined);
  assert.equal(email?.payload.value_redacted, true);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(calls, ["launch:emulator-5554:com.example.app", "close"]);
});

test("each observation starts its own per-session sequence at one", async () => {
  const device = {
    id: "emulator-5554",
    screen: { viewTree: async () => [] },
    getForegroundApp: async () => ({ bundleId: "com.example.app" }),
    screenSize: async () => ({ width: 1, height: 1, scale: 1 }),
    close: async () => {}
  };
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => device },
    android: { launch: async () => device }
  });
  const first = await adapter.observe(session);
  const second = await adapter.observe({ ...session, session_id: "d8bdba44-7dbd-4a34-a2bb-1fdc93a40002" });
  assert.equal(first[0]?.sequence, 1);
  assert.equal(second[0]?.sequence, 1);
});

test("Mobilewright discovery rejects web and hybrid sessions", async () => {
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => { throw new Error("not called"); } },
    android: { launch: async () => { throw new Error("not called"); } }
  });
  await assert.rejects(() => adapter.observe({ ...session, platform: "web" }), /mobilewright_discovery_platform_unsupported:web/);
  await assert.rejects(() => adapter.observe({ ...session, platform: "hybrid" }), /mobilewright_discovery_platform_unsupported:hybrid/);
});

test("Mobilewright discovery requires an app bundle identifier", () => {
  assert.throws(() => new MobilewrightDiscoveryAdapter({ bundleId: " " }), /MOBILE_APP_BUNDLE_ID is required/);
});
