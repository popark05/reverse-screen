import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { PlaywrightDiscoveryAdapter } from "../src/adapters/playwright-discovery-adapter.js";

test("Playwright discovery converts a page into ordered normalized discovery events", async () => {
  const observedElements = [
    { tag: "button", role: "button", name: "Sign in", text: "Sign in", testId: "login", disabled: false, visible: true, selector: '[data-testid="login"]' },
    { tag: "input", role: "textbox", name: "Email", text: "", inputType: "email", disabled: false, visible: true, selector: "#email" }
  ];
  const page = {
    url: () => "https://example.test/login?source=qa",
    title: () => "Login",
    locator: () => ({
      evaluateAll: async () => observedElements
    })
  } as unknown as Page;
  const adapter = new PlaywrightDiscoveryAdapter(page, {
    sessionId: "b6a3f8e4-4a1d-4c0d-9e1a-1e5e6c7d8f90",
    applicationId: "sample-app",
    targetId: "chromium"
  });

  const events = await adapter.observe();
  assert.equal(events[0]?.event_type, "screen_observed");
  assert.equal(events[0]?.sequence, 1);
  assert.equal(events[0]?.payload.route, "/login");
  assert.equal(events.filter((event) => event.event_type === "element_observed").length, 2);
  assert.equal(events.filter((event) => event.event_type === "action_candidate").length, 2);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.every((event) => event.platform === "web"), true);
});

test("Playwright discovery bounds the number of elements in one observation", async () => {
  const page = {
    url: () => "https://example.test/",
    title: () => "Home",
    locator: () => ({
      evaluateAll: async () => Array.from({ length: 5 }, (_, index) => ({
        tag: "button", role: "button", name: `Button ${index}`, text: `Button ${index}`,
        disabled: false, visible: true, selector: `button:nth-of-type(${index + 1})`
      }))
    })
  } as unknown as Page;
  const adapter = new PlaywrightDiscoveryAdapter(page, {
    sessionId: "b6a3f8e4-4a1d-4c0d-9e1a-1e5e6c7d8f90",
    applicationId: "sample-app", targetId: "chromium", maxElements: 2
  });
  const events = await adapter.observe();
  assert.equal(events[0]?.payload.element_count, 2);
  assert.equal(events[0]?.payload.truncated, true);
  assert.equal(events.filter((event) => event.event_type === "element_observed").length, 2);
});


test("Playwright discovery captures a PNG screenshot linked to its screen event", async () => {
  const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const page = {
    url: () => "https://example.test/dashboard",
    title: () => "Dashboard",
    locator: () => ({
      evaluateAll: async () => [],
      evaluate: async () => ({
        html: '<main><input value="[REDACTED]"></main>',
        accessibilityTree: { role: "generic", tag: "body", visible: true, enabled: true, children: [] }
      })
    }),
    screenshot: async (options: { type: "png" }) => {
      assert.equal(options.type, "png");
      return screenshot;
    }
  } as unknown as Page;
  const adapter = new PlaywrightDiscoveryAdapter(page, {
    sessionId: "b6a3f8e4-4a1d-4c0d-9e1a-1e5e6c7d8f90",
    applicationId: "sample-app",
    targetId: "chromium"
  });

  const observation = await adapter.observeWithEvidence();
  assert.equal(observation.events[0]?.event_type, "screen_observed");
  assert.equal(observation.evidence.length, 3);
  assert.equal(observation.evidence[0]?.kind, "screenshot");
  assert.equal(observation.evidence[0]?.content_type, "image/png");
  assert.equal(observation.evidence[0]?.event_id, observation.events[0]?.event_id);
  assert.deepEqual(observation.evidence[0]?.bytes, screenshot);
  assert.equal(observation.evidence[1]?.kind, "dom_snapshot");
  assert.equal(observation.evidence[1]?.content_type, "text/html; charset=utf-8");
  assert.match(Buffer.from(observation.evidence[1]!.bytes).toString("utf8"), /\\[REDACTED\\]/);
  assert.equal(observation.evidence[2]?.kind, "accessibility_tree");
  assert.equal(observation.evidence[2]?.content_type, "application/json");
  assert.equal(observation.evidence[2]?.event_id, observation.events[0]?.event_id);
});
