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
  const screenId = randomUUID();
  const stateId = randomUUID();

  const base = {
    session_id: target.sessionId,
    occurred_at: occurredAt,
    platform: target.platform,
    evidence_ids: []
  } as const;

  return [
    {
      ...base,
      event_id: randomUUID(),
      sequence: 1,
      event_type: "screen_observed",
      screen_id: screenId,
      state_id: stateId,
      payload: {
        application_id: target.applicationId,
        target_id: target.targetId,
        screen_key: "screen.home",
        name: "Home",
        route: "/"
      }
    },
    {
      ...base,
      event_id: randomUUID(),
      sequence: 2,
      event_type: "element_observed",
      screen_id: screenId,
      state_id: stateId,
      payload: {
        element_key: "element.login",
        role: "button",
        accessible_name: "Log in"
      }
    },
    {
      ...base,
      event_id: randomUUID(),
      sequence: 3,
      event_type: "action_candidate",
      screen_id: screenId,
      state_id: stateId,
      payload: { action: "tap", target_element_key: "element.login" }
    }
  ];
}
