import { randomUUID } from "node:crypto";
import type { DiscoveryEvent, Platform } from "../domain/discovery-event.js";

export interface MockDiscoveryTarget {
  applicationId: string;
  sessionId: string;
  targetId: string;
  platform: Platform;
}

export function createMockDiscoveryEvents(target: MockDiscoveryTarget): DiscoveryEvent[] {
  const occurredAt = new Date().toISOString();
  const screenId = "screen.home";
  const stateId = "state.home.default";

  const base = {
    sessionId: target.sessionId,
    applicationId: target.applicationId,
    platform: target.platform,
    targetId: target.targetId,
    occurredAt
  } as const;

  return [
    {
      ...base,
      eventId: randomUUID(),
      type: "screen.discovered",
      payload: { screenId, name: "Home", route: "/" }
    },
    {
      ...base,
      eventId: randomUUID(),
      type: "screen.state.observed",
      payload: { screenId, stateId, name: "default" }
    },
    {
      ...base,
      eventId: randomUUID(),
      type: "element.discovered",
      payload: {
        screenId,
        stateId,
        elementId: "element.login",
        role: "button",
        accessibleName: "Log in"
      }
    }
  ];
}
