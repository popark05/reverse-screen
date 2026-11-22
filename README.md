# Reverse Screen

Runtime discovery engine for web, mobile and hybrid applications. Reverse Screen observes running applications and produces normalized screen, state, element, action and transition data for downstream wireflow review and QA authoring.

## Development

- Node.js 22+
- PostgreSQL 14+ (optional for local in-memory development)

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
- Runtime discovery adapters are separate from persistence and will be added incrementally.
