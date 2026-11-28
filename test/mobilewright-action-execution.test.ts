import assert from "node:assert/strict";
import test from "node:test";
import { MobilewrightDiscoveryAdapter } from "../src/adapters/mobilewright-discovery-adapter.js";
import type { DiscoveryActionRequest } from "../src/domain/discovery-action.js";
import type { DiscoverySession } from "../src/domain/discovery-session.js";

const session: DiscoverySession = {
  session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001", application_id: "sample-app",
  platform: "android", target_id: "emulator-5554", status: "completed",
  created_at: "2026-11-22T00:00:00.000Z", updated_at: "2026-11-22T00:00:00.000Z"
};

test("executes native tap actions through Mobilewright locators", async () => {
  const calls: string[] = [];
  const nativeLocator = {
    tap: async () => { calls.push("native-tap"); },
    fill: async (value: string) => { calls.push(`native-fill:${value}`); }
  };
  const device = {
    id: "emulator-5554",
    screen: {
      viewTree: async () => [], getByWebView: () => ({ count: async () => 0 }),
      getByRole: (role: string, options?: { name?: string }) => { calls.push(`role:${role}:${options?.name}`); return nativeLocator; },
      getByLabel: (label: string) => { calls.push(`label:${label}`); return nativeLocator; },
      getByTestId: (id: string) => { calls.push(`test-id:${id}`); return nativeLocator; },
      screenshot: async () => Buffer.from("png")
    },
    getForegroundApp: async () => ({ bundleId: "com.example.app" }),
    screenSize: async () => ({ width: 1, height: 1, scale: 1 }),
    close: async () => { calls.push("device-close"); }
  };
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => device as never }, android: { launch: async () => device as never }
  });
  const event = await adapter.executeAction(session, {
    context_type: "native", action: "tap", locator_strategy: "role_name",
    locator_role: "button", locator_name: "Continue"
  });
  assert.equal(event.event_type, "action_executed");
  assert.equal(event.payload.context_type, "native");
  assert.equal(event.payload.action, "tap");
  assert.deepEqual(calls, ["role:button:Continue", "native-tap", "device-close"]);
});

test("executes WebView fill actions without recording the entered value", async () => {
  const calls: string[] = [];
  let webLocator: any;
  webLocator = {
    count: async () => 1, nth: () => webLocator,
    getAttribute: async () => null, innerText: async () => "",
    boundingBox: async () => null, isVisible: async () => true, isEnabled: async () => true,
    click: async () => { calls.push("web-click"); },
    fill: async (value: string) => { calls.push(`web-fill:${value}`); }
  };
  const page = {
    url: () => "https://example.test/login", title: async () => "Login", content: async () => "<html></html>",
    locator: () => webLocator, getByRole: () => webLocator, getByLabel: () => webLocator,
    getByTestId: () => webLocator, close: async () => { calls.push("page-close"); }
  };
  const device = {
    id: "emulator-5554",
    screen: {
      viewTree: async () => [], getByWebView: () => ({ count: async () => 1, nth: () => ({ page: async () => page }) }),
      getByRole: () => ({ tap: async () => {}, fill: async () => {} }),
      getByLabel: () => ({ tap: async () => {}, fill: async () => {} }),
      getByTestId: () => ({ tap: async () => {}, fill: async () => {} }),
      screenshot: async () => Buffer.from("png")
    },
    getForegroundApp: async () => ({ bundleId: "com.example.app" }),
    screenSize: async () => ({ width: 1, height: 1, scale: 1 }),
    close: async () => { calls.push("device-close"); }
  };
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => device as never }, android: { launch: async () => device as never }
  });
  const request: DiscoveryActionRequest = {
    context_type: "webview", action: "fill", locator_strategy: "label",
    locator_value: "Email", input_value: "secret@example.test"
  };
  const event = await adapter.executeAction(session, request);
  assert.equal(event.payload.value_redacted, true);
  assert.equal(JSON.stringify(event).includes("secret@example.test"), false);
  assert.deepEqual(calls, ["web-fill:secret@example.test", "page-close", "device-close"]);
});
