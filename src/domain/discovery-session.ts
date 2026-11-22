import { randomUUID } from "node:crypto";
import type { Platform } from "./discovery-event.js";

export type DiscoverySessionStatus = "created" | "running" | "completed" | "failed" | "cancelled";

export interface DiscoverySession {
  session_id: string;
  application_id: string;
  platform: Platform;
  target_id: string;
  status: DiscoverySessionStatus;
  started_at?: string;
  finished_at?: string;
  failure_reason?: string;
  created_at: string;
  updated_at: string;
}

export class DiscoverySessionStore {
  private readonly sessions = new Map<string, DiscoverySession>();

  create(input: Pick<DiscoverySession, "application_id" | "platform" | "target_id">): DiscoverySession {
    const now = new Date().toISOString();
    const session: DiscoverySession = {
      session_id: randomUUID(),
      ...input,
      status: "created",
      created_at: now,
      updated_at: now
    };
    this.sessions.set(session.session_id, session);
    return session;
  }

  get(sessionId: string): DiscoverySession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): DiscoverySession[] {
    return [...this.sessions.values()];
  }

  transition(sessionId: string, next: Exclude<DiscoverySessionStatus, "created">, failureReason?: string): DiscoverySession | undefined {
    const current = this.sessions.get(sessionId);
    if (!current) return undefined;
    const allowed: Record<DiscoverySessionStatus, DiscoverySessionStatus[]> = {
      created: ["running", "cancelled"],
      running: ["completed", "failed", "cancelled"],
      completed: [],
      failed: [],
      cancelled: []
    };
    if (!allowed[current.status].includes(next)) return undefined;
    const now = new Date().toISOString();
    const updated: DiscoverySession = {
      ...current,
      status: next,
      updated_at: now,
      ...(next === "running" ? { started_at: now } : {}),
      ...(["completed", "failed", "cancelled"].includes(next) ? { finished_at: now } : {}),
      ...(failureReason === undefined ? {} : { failure_reason: failureReason })
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }
}
