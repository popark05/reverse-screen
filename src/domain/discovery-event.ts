export const DISCOVERY_EVENT_TYPES = [
  "screen.discovered",
  "screen.state.observed",
  "element.discovered",
  "action.performed",
  "transition.observed",
  "flow.completed"
] as const;

export type DiscoveryEventType = (typeof DISCOVERY_EVENT_TYPES)[number];
export type Platform = "web" | "android" | "ios";

export interface DiscoveryEvent {
  eventId: string;
  sessionId: string;
  applicationId: string;
  applicationVersion?: string;
  platform: Platform;
  targetId: string;
  occurredAt: string;
  type: DiscoveryEventType;
  payload: Record<string, unknown>;
}

export interface StoredDiscoveryEvent extends DiscoveryEvent {
  receivedAt: string;
}

export interface DiscoveryEventStore {
  append(event: DiscoveryEvent): { event: StoredDiscoveryEvent; duplicate: boolean };
  listBySession(sessionId: string): StoredDiscoveryEvent[];
}

export class InMemoryDiscoveryEventStore implements DiscoveryEventStore {
  private readonly eventsById = new Map<string, StoredDiscoveryEvent>();
  private readonly eventIdsBySession = new Map<string, string[]>();

  append(event: DiscoveryEvent): { event: StoredDiscoveryEvent; duplicate: boolean } {
    const existing = this.eventsById.get(event.eventId);
    if (existing) return { event: existing, duplicate: true };

    const stored: StoredDiscoveryEvent = { ...event, receivedAt: new Date().toISOString() };
    this.eventsById.set(event.eventId, stored);
    const ids = this.eventIdsBySession.get(event.sessionId) ?? [];
    ids.push(event.eventId);
    this.eventIdsBySession.set(event.sessionId, ids);
    return { event: stored, duplicate: false };
  }

  listBySession(sessionId: string): StoredDiscoveryEvent[] {
    return (this.eventIdsBySession.get(sessionId) ?? [])
      .map((id) => this.eventsById.get(id))
      .filter((event): event is StoredDiscoveryEvent => event !== undefined);
  }
}
