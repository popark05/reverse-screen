import { randomUUID } from "node:crypto";

export interface HybridWebViewContextObservation {
  contextKey: string;
  screenId: string;
  stateId: string;
  webViewIndex: number;
  url: string;
  title: string;
}

export interface HybridContextLifecycleSnapshot {
  transitionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
  firstObservationNumber: number;
  lastObservationNumber: number;
}

interface TrackedContext {
  context: HybridWebViewContextObservation;
  lifecycle: HybridContextLifecycleSnapshot;
  active: boolean;
}

export interface HybridContextLifecycleResult {
  observationNumber: number;
  active: Array<{
    context: HybridWebViewContextObservation;
    lifecycle: HybridContextLifecycleSnapshot;
    isNew: boolean;
  }>;
  detached: Array<{
    context: HybridWebViewContextObservation;
    lifecycle: HybridContextLifecycleSnapshot;
    detachedAt: string;
    observationNumber: number;
  }>;
}

/**
 * Tracks WebView presence between complete observations for one discovery session.
 * It deliberately reports observation presence/absence, not verified user navigation.
 */
export class HybridContextLifecycleTracker {
  private readonly sessions = new Map<string, Map<string, TrackedContext>>();
  private readonly observationNumbers = new Map<string, number>();

  constructor(
    private readonly maxSessions = 500,
    private readonly maxContextsPerSession = 2000
  ) {}

  reconcile(
    sessionId: string,
    observedAt: string,
    observations: HybridWebViewContextObservation[]
  ): HybridContextLifecycleResult {
    let contexts = this.sessions.get(sessionId);
    if (!contexts) {
      if (this.sessions.size >= this.maxSessions) {
        const oldestSession = this.sessions.keys().next().value as string | undefined;
        if (oldestSession) {
          this.sessions.delete(oldestSession);
          this.observationNumbers.delete(oldestSession);
        }
      }
      contexts = new Map();
      this.sessions.set(sessionId, contexts);
    } else {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, contexts);
    }

    const observationNumber = (this.observationNumbers.get(sessionId) ?? 0) + 1;
    this.observationNumbers.set(sessionId, observationNumber);
    const seen = new Set<string>();
    const active: HybridContextLifecycleResult["active"] = [];

    for (const context of observations) {
      seen.add(context.contextKey);
      const previous = contexts.get(context.contextKey);
      const isNew = !previous || !previous.active;
      const lifecycle: HybridContextLifecycleSnapshot = isNew
        ? {
            transitionId: randomUUID(),
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
            observationCount: 1,
            firstObservationNumber: observationNumber,
            lastObservationNumber: observationNumber
          }
        : {
            ...previous.lifecycle,
            lastSeenAt: observedAt,
            observationCount: previous.lifecycle.observationCount + 1,
            lastObservationNumber: observationNumber
          };
      contexts.set(context.contextKey, { context, lifecycle, active: true });
      active.push({ context, lifecycle, isNew });
    }

    const detached: HybridContextLifecycleResult["detached"] = [];
    for (const [contextKey, tracked] of contexts) {
      if (!tracked.active || seen.has(contextKey)) continue;
      tracked.active = false;
      detached.push({
        context: tracked.context,
        lifecycle: tracked.lifecycle,
        detachedAt: observedAt,
        observationNumber
      });
    }

    while (contexts.size > this.maxContextsPerSession) {
      const inactiveKey = [...contexts].find(([, tracked]) => !tracked.active)?.[0];
      if (!inactiveKey) break;
      contexts.delete(inactiveKey);
    }

    return { observationNumber, active, detached };
  }
}
