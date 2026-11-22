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
