# Reverse Screen

Runtime discovery engine for web, mobile and hybrid applications. Reverse Screen observes running applications and produces normalized screen, state, element, action and transition data for downstream wireflow review and QA authoring.

## Development

- Node.js 22+
- PostgreSQL 14+ (optional for local in-memory development)
- Playwright (for web discovery; browser lifecycle is managed by the caller)

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Without `DATABASE_URL`, the API uses in-memory repositories. To enable PostgreSQL persistence:

1. Create a database and apply `db/migrations/001_initial.sql`.
2. Set `DATABASE_URL` to the PostgreSQL connection string.
3. Start the service with `npm start` (or `npm run dev`).

Optional pool setting: `DB_POOL_MAX` (default: 10).

## Playwright web discovery adapter

`PlaywrightDiscoveryAdapter` accepts an already-connected Playwright `Page`; it does not launch or own the browser. Call `observe()` to receive a sequence of normalized `DiscoveryEvent` objects. Send those events to `POST /v1/discovery-events` or persist them through a configured repository.

The first event describes the current screen. Subsequent events describe observed interactive elements and action candidates. The adapter captures URL, title, route, semantic name/role, visibility, enabled state and locator candidates. Element count is bounded (default 250) to avoid unbounded DOM extraction.

This web adapter uses DOM inspection. Mobile discovery must not assume DOM/WebView access: native Android/iOS adapters should use accessibility and platform observations, with WebView inspection as an optional capability.

## API

- `GET /health`
- `POST /v1/discovery-sessions`
- `GET /v1/discovery-sessions`
- `GET /v1/discovery-sessions/:sessionId`
- `POST /v1/discovery-sessions/:sessionId/transitions`
- `POST /v1/discovery-sessions/:sessionId/events`
- `POST /v1/discovery-events`

The PostgreSQL repository persists discovery sessions and events. Event ingestion is idempotent by `event_id`; the database additionally enforces unique sequence numbers within a session. A repeated event ID returns the original stored event. A sequence collision with a different event ID is rejected by PostgreSQL.

## Current boundaries

- Evidence binary storage is not implemented; only evidence IDs are persisted.
- Authentication, tenant isolation, retention policies and migration orchestration are not implemented.
- The in-memory mode is intended for tests and local exploration, not multi-process production use.
- Browser launch/session management and runtime mobile discovery adapters are not implemented.
