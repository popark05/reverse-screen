# Reverse Screen

Runtime discovery engine for web, mobile and hybrid applications. Reverse Screen observes running applications and produces normalized screen, state, element, action and transition data for downstream wireflow review and QA authoring.

## Development

- Node.js 22.12+
- PostgreSQL 14+ (optional for local in-memory development)
- Playwright for web discovery
- Mobilewright for native Android/iOS discovery

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Without `DATABASE_URL`, the API uses in-memory repositories. To enable PostgreSQL persistence, apply `db/migrations/001_initial.sql` and set `DATABASE_URL`.

## Playwright web discovery adapter

`PlaywrightDiscoveryAdapter` accepts an already-connected Playwright `Page`; it does not launch or own the browser. Call `observe()` to receive normalized `DiscoveryEvent` objects. The adapter captures URL, title, route, semantic names/roles, visibility, enabled state and locator candidates. Element count is bounded (default 250).

## Mobilewright native discovery

The opt-in `MobilewrightDiscoveryAdapter` connects to a selected Android or iOS device, reads the documented accessibility `viewTree()`, and normalizes the tree into `screen_observed`, `element_observed`, and `action_candidate` events. It does not require WebView DOM access and does not persist editable-field values. The device connection is closed after each observation.

Configure the runtime and enable the observer:

```bash
npx mobilewright doctor
MOBILE_DISCOVERY_ADAPTER=mobilewright \
MOBILE_APP_BUNDLE_ID=com.example.app \
MOBILE_APP_PATH=./build/app.apk \
npm start
```

`MOBILE_APP_PATH` is optional; when supplied, Mobilewright installs the APK/IPA before launching. Create a session with `platform: "android"` or `platform: "ios"` and `target_id` set to the device serial/UDID, then call:

```http
POST /v1/discovery-sessions/{sessionId}/observe
```

The endpoint moves the session through `created -> running -> completed`, stores the normalized events, and marks the session failed if observation fails. `MOBILE_DISCOVERY_MAX_ELEMENTS` bounds one hierarchy snapshot (default 300). Web and hybrid sessions are rejected by this native observer; hybrid native/WebView context orchestration remains a separate increment.

## API

- `GET /health`
- `POST /v1/discovery-sessions`
- `GET /v1/discovery-sessions`
- `GET /v1/discovery-sessions/:sessionId`
- `POST /v1/discovery-sessions/:sessionId/observe` (when an observer is configured)
- `POST /v1/discovery-sessions/:sessionId/transitions`
- `POST /v1/discovery-sessions/:sessionId/events`
- `POST /v1/discovery-events`

Event ingestion is idempotent by `event_id`; PostgreSQL additionally enforces unique sequence numbers within a session.

## Current boundaries

- Evidence binary storage is not implemented; screenshots are not yet uploaded or linked as evidence artifacts.
- Native accessibility hierarchy is normalized into event payloads; sensitive editable-field values are redacted.
- Authentication, tenant isolation, retention policies and migration orchestration are not implemented.
- In-memory mode is intended for tests/local exploration, not multi-process production use.
