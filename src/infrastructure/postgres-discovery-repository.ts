import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DiscoveryEvent, DiscoveryEventStore, StoredDiscoveryEvent } from "../domain/discovery-event.js";
import type {
  CreateDiscoverySessionInput, DiscoverySession, DiscoverySessionRepository, DiscoverySessionStatus
} from "../domain/discovery-session.js";

interface SessionRow {
  session_id: string; application_id: string; platform: DiscoverySession["platform"];
  target_id: string; status: DiscoverySessionStatus; started_at: Date | null;
  finished_at: Date | null; failure_reason: string | null; created_at: Date; updated_at: Date;
}
interface EventRow {
  event_id: string; session_id: string; sequence: number; event_type: DiscoveryEvent["event_type"];
  occurred_at: Date; platform: DiscoveryEvent["platform"]; screen_id: string | null;
  state_id: string | null; transition_id: string | null; payload: Record<string, unknown>;
  evidence_ids: string[]; received_at: Date;
}

const iso = (value: Date | string | null): string | undefined =>
  value === null ? undefined : (value instanceof Date ? value : new Date(value)).toISOString();

function mapSession(row: SessionRow): DiscoverySession {
  return {
    session_id: row.session_id, application_id: row.application_id, platform: row.platform,
    target_id: row.target_id, status: row.status, created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
    ...(row.started_at ? { started_at: iso(row.started_at)! } : {}),
    ...(row.finished_at ? { finished_at: iso(row.finished_at)! } : {}),
    ...(row.failure_reason ? { failure_reason: row.failure_reason } : {})
  };
}

function mapEvent(row: EventRow): StoredDiscoveryEvent {
  return {
    event_id: row.event_id, session_id: row.session_id, sequence: row.sequence,
    event_type: row.event_type, occurred_at: iso(row.occurred_at)!, platform: row.platform,
    ...(row.screen_id === null ? {} : { screen_id: row.screen_id }),
    ...(row.state_id === null ? {} : { state_id: row.state_id }),
    ...(row.transition_id === null ? {} : { transition_id: row.transition_id }),
    payload: row.payload, evidence_ids: row.evidence_ids, received_at: iso(row.received_at)!
  };
}

export class PostgresDiscoveryRepository implements DiscoverySessionRepository, DiscoveryEventStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateDiscoverySessionInput): Promise<DiscoverySession> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO discovery_session (session_id, application_id, platform, target_id, status)
       VALUES ($1, $2, $3, $4, 'created') RETURNING *`,
      [randomUUID(), input.application_id, input.platform, input.target_id]
    );
    return mapSession(result.rows[0]!);
  }

  async get(sessionId: string): Promise<DiscoverySession | undefined> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM discovery_session WHERE session_id = $1", [sessionId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async list(): Promise<DiscoverySession[]> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM discovery_session ORDER BY created_at DESC"
    );
    return result.rows.map(mapSession);
  }

  async transition(
    sessionId: string,
    next: Exclude<DiscoverySessionStatus, "created">,
    failureReason?: string
  ): Promise<DiscoverySession | undefined> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE discovery_session
       SET status = $2,
           started_at = CASE WHEN $2 = 'running' THEN now() ELSE started_at END,
           finished_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE finished_at END,
           failure_reason = COALESCE($3, failure_reason),
           updated_at = now()
       WHERE session_id = $1
         AND (($2 IN ('running', 'cancelled') AND status = 'created')
           OR ($2 IN ('completed', 'failed', 'cancelled') AND status = 'running'))
       RETURNING *`,
      [sessionId, next, failureReason ?? null]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async append(event: DiscoveryEvent): Promise<{ event: StoredDiscoveryEvent; duplicate: boolean }> {
    const inserted = await this.pool.query<EventRow>(
      `INSERT INTO discovery_event
       (event_id, session_id, sequence, event_type, occurred_at, platform, screen_id, state_id,
        transition_id, payload, evidence_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid[])
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [event.event_id, event.session_id, event.sequence, event.event_type, event.occurred_at,
        event.platform, event.screen_id ?? null, event.state_id ?? null, event.transition_id ?? null,
        JSON.stringify(event.payload), event.evidence_ids ?? []]
    );
    if (inserted.rows[0]) return { event: mapEvent(inserted.rows[0]), duplicate: false };

    const existing = await this.pool.query<EventRow>(
      "SELECT * FROM discovery_event WHERE event_id = $1", [event.event_id]
    );
    if (!existing.rows[0]) throw new Error("Event insert conflicted but the existing event could not be loaded");
    return { event: mapEvent(existing.rows[0]), duplicate: true };
  }

  async listBySession(sessionId: string): Promise<StoredDiscoveryEvent[]> {
    const result = await this.pool.query<EventRow>(
      "SELECT * FROM discovery_event WHERE session_id = $1 ORDER BY sequence ASC", [sessionId]
    );
    return result.rows.map(mapEvent);
  }
}
