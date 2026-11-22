export const DISCOVERY_EVENT_TYPES = [
  "screen_observed",
  "element_observed",
  "action_candidate",
  "action_executed",
  "transition_observed",
  "assertion_observed",
  "error",
  "session_marker"
] as const;

export type DiscoveryEventType = (typeof DISCOVERY_EVENT_TYPES)[number];
export type Platform = "web" | "android" | "ios" | "hybrid";

export interface DiscoveryEvent {
  event_id: string;
  session_id: string;
  sequence: number;
  event_type: DiscoveryEventType;
  occurred_at: string;
  platform: Platform;
  screen_id?: string | null;
  state_id?: string | null;
  transition_id?: string | null;
  payload: Record<string, unknown>;
  evidence_ids?: string[];
}

export interface StoredDiscoveryEvent extends DiscoveryEvent {
  received_at: string;
}

export interface DiscoveryEventStore {
  append(event: DiscoveryEvent): { event: StoredDiscoveryEvent; duplicate: boolean };
  listBySession(sessionId: string): StoredDiscoveryEvent[];
}

export class InMemoryDiscoveryEventStore implements DiscoveryEventStore {
  private readonly eventsById = new Map<string, StoredDiscoveryEvent>();
  private readonly eventIdsBySession = new Map<string, string[]>();

  append(event: DiscoveryEvent): { event: StoredDiscoveryEvent; duplicate: boolean } {
    const existing = this.eventsById.get(event.event_id);
    if (existing) return { event: existing, duplicate: true };

    const stored: StoredDiscoveryEvent = { ...event, received_at: new Date().toISOString() };
    this.eventsById.set(event.event_id, stored);
    const ids = this.eventIdsBySession.get(event.session_id) ?? [];
    ids.push(event.event_id);
    this.eventIdsBySession.set(event.session_id, ids);
    return { event: stored, duplicate: false };
  }

  listBySession(sessionId: string): StoredDiscoveryEvent[] {
    return (this.eventIdsBySession.get(sessionId) ?? [])
      .map((id) => this.eventsById.get(id))
      .filter((event): event is StoredDiscoveryEvent => event !== undefined);
  }
}
