import assert from "node:assert/strict";
import test from "node:test";
import { MobilewrightDiscoveryAdapter } from "../src/adapters/mobilewright-discovery-adapter.js";
import type { DiscoverySession } from "../src/domain/discovery-session.js";

const session: DiscoverySession = {
  session_id: "c8bdba44-7dbd-4a34-a2bb-1fdc93a40001", application_id: "sample-app",
  platform: "android", target_id: "emulator-5554", status: "running",
  created_at: "2026-11-22T00:00:00.000Z", updated_at: "2026-11-22T00:00:00.000Z"
};

test("Mobilewright discovery emits native and WebView contexts in one ordered session", async () => {
  const calls: string[] = [];
  const page = {
    url: () => "https://app.example.test/checkout",
    title: async () => "Checkout",
    content: async () => "<html><body><input type='password' value='secret'><button>Pay</button></body></html>",
    locator: () => ({ count: async () => 4 }),
    getByRole: (role: string) => ({
      count: async () => role === "button" || role === "textbox" ? 1 : 0,
      nth: () => ({
        getAttribute: async (name: string) => name === "aria-label" && role === "button" ? "Pay now" : name === "placeholder" && role === "textbox" ? "Card number" : null,
        innerText: async () => role === "button" ? "Pay now" : "secret",
        boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
        isVisible: async () => true,
        isEnabled: async () => true
      })
    }),
    close: async () => { calls.push("page-close"); }
  };
  const device = {
    id: "emulator-5554",
    screen: {
      viewTree: async () => [{
        type: "Button", label: "Open checkout", identifier: "checkout",
        isVisible: true, isEnabled: true, bounds: { x: 0, y: 0, width: 120, height: 48 }, children: []
      }],
      getByWebView: () => ({ count: async () => 1, nth: () => ({ page: async () => page }) }),
      screenshot: async () => Buffer.from("png")
    },
    getForegroundApp: async () => ({ bundleId: "com.example.app", name: "Example", version: "1.0" }),
    screenSize: async () => ({ width: 1080, height: 2400, scale: 3 }),
    close: async () => { calls.push("device-close"); }
  };
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => device as never }, android: { launch: async () => device as never }
  });
  const events = await adapter.observe(session);
  assert.equal(events[0]?.payload.context_type, "native");
  const webScreen = events.find((event) => event.event_type === "screen_observed" && event.payload.context_type === "webview");
  assert.equal(webScreen?.payload.url, "https://app.example.test/checkout");
  assert.equal(webScreen?.payload.dom_element_count, 4);
  const webElements = events.filter((event) => event.event_type === "element_observed" && event.payload.context_type === "webview");
  assert.equal(webElements.length, 2);
  assert.equal(webElements.find((event) => event.payload.role === "textbox")?.payload.text, undefined);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(calls, ["page-close", "device-close"]);
});

test("native-only apps complete discovery when no WebView is present", async () => {
  const device = {
    id: "emulator-5554",
    screen: { viewTree: async () => [], getByWebView: () => ({ count: async () => 0 }), screenshot: async () => Buffer.from("png") },
    getForegroundApp: async () => ({ bundleId: "com.example.app" }),
    screenSize: async () => ({ width: 1, height: 1, scale: 1 }), close: async () => {}
  };
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => device as never }, android: { launch: async () => device as never }
  });
  const events = await adapter.observe(session);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.context_type, "native");
});

test("Mobilewright discovery rejects unsupported platforms and requires bundle identifier", async () => {
  const adapter = new MobilewrightDiscoveryAdapter({ bundleId: "com.example.app" }, {
    ios: { launch: async () => { throw new Error("not called"); } },
    android: { launch: async () => { throw new Error("not called"); } }
  });
  await assert.rejects(() => adapter.observe({ ...session, platform: "web" }), /mobilewright_discovery_platform_unsupported:web/);
  assert.throws(() => new MobilewrightDiscoveryAdapter({ bundleId: " " }), /MOBILE_APP_BUNDLE_ID is required/);
});
