# Reverse Screen

Runtime discovery engine for web, mobile and hybrid applications. Reverse Screen observes running applications and produces normalized screen, state, element, action and transition data for downstream wireflow review and QA authoring.

## Development

- Node.js 22.12+
- PostgreSQL 14+ (optional for local in-memory development)
- Playwright for web discovery
- Mobilewright for native Android/iOS and embedded WebView discovery

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Without `DATABASE_URL`, the API uses in-memory repositories. To enable PostgreSQL persistence, apply migrations in order:
`db/migrations/001_initial.sql`, then `db/migrations/002_evidence_artifact.sql`, and set `DATABASE_URL`.

## Playwright web discovery adapter

`PlaywrightDiscoveryAdapter` accepts an already-connected Playwright `Page`; it does not launch or own the browser. Call `observe()` to receive normalized `DiscoveryEvent` objects. The adapter captures URL, title, route, semantic names/roles, visibility, enabled state and locator candidates. Element count is bounded (default 250).

## Mobilewright native and hybrid discovery

The opt-in `MobilewrightDiscoveryAdapter` connects to a selected Android or iOS device and reads the documented accessibility `screen.viewTree()`. It always emits a native context. It then checks `screen.getByWebView()`; each available WebView is attached with `.nth(index).page()` and inspected through the documented Playwright-compatible page/locator surface.

A single Discovery Session therefore emits:
- `screen_observed` and `element_observed` events with `payload.context_type = "native"` for the native accessibility hierarchy
- corresponding events with `payload.context_type = "webview"` for semantic DOM roles, URL/title, element bounds and locator candidates
- WebView screen metadata includes a SHA-256 hash of the DOM snapshot, not the raw HTML

The session's `platform` remains the device OS (`android` or `ios`); `context_type` distinguishes native and embedded web content. This avoids treating a hybrid app as a third device operating system. Editable values are not emitted. WebView textboxes are recorded as metadata only, without reading their current values. The HTML snapshot is hashed in memory and discarded.

Configure and enable discovery:

```bash
npx mobilewright doctor
MOBILE_DISCOVERY_ADAPTER=mobilewright \
MOBILE_APP_BUNDLE_ID=com.example.app \
MOBILE_APP_PATH=./build/app.apk \
MOBILE_DISCOVERY_MAX_ELEMENTS=300 \
MOBILE_DISCOVERY_MAX_WEBVIEW_ELEMENTS=200 \
npm start
```

`MOBILE_APP_PATH` is optional; when supplied, Mobilewright installs the APK/IPA before launching. Create a session with `platform: "android"` or `platform: "ios"` and `target_id` set to the device serial/UDID, then call:

```http
POST /v1/discovery-sessions/{sessionId}/observe
```

The endpoint moves the session through `created -> running -> completed`, stores normalized events, and marks the session failed if observation fails. A native-only app simply produces no WebView events. `MOBILE_DISCOVERY_MAX_ELEMENTS` bounds native elements (default 300); `MOBILE_DISCOVERY_MAX_WEBVIEW_ELEMENTS` bounds semantic WebView elements (default 200).

## Evidence artifact metadata

Binary evidence belongs in an object store; PostgreSQL stores only metadata and a stable object URI. The current increment adds the metadata contract and repository/API, but does not yet upload binary bytes or issue signed upload/download URLs.

Supported kinds: `screenshot`, `video`, `dom_snapshot`, `accessibility_tree`, `log`, `network_trace`.

- `POST /v1/evidence-artifacts` — register metadata after the object has been uploaded
- `GET /v1/evidence-artifacts/:evidenceId` — retrieve metadata
- `GET /v1/discovery-sessions/:sessionId/evidence` — list session evidence

Metadata includes `session_id`, optional `event_id`, `kind`, `content_type`, `byte_size`, SHA-256 checksum, stable `storage_uri`, and `captured_at`. The API validates the checksum format and storage URI scheme and verifies that the discovery session exists.

## API

- `GET /health`
- `POST /v1/discovery-sessions`
- `GET /v1/discovery-sessions`
- `GET /v1/discovery-sessions/:sessionId`
- `POST /v1/discovery-sessions/:sessionId/observe` (when an observer is configured)
- `POST /v1/discovery-sessions/:sessionId/transitions`
- `POST /v1/discovery-sessions/:sessionId/events`
- `GET /v1/discovery-sessions/:sessionId/events`
- `POST /v1/evidence-artifacts`
- `GET /v1/evidence-artifacts/:evidenceId`
- `GET /v1/discovery-sessions/:sessionId/evidence`

Event ingestion is idempotent by `event_id`; PostgreSQL additionally enforces unique sequence numbers within a session.

## Current boundaries

- Evidence binary upload, object-store lifecycle, signed URLs and retention are not implemented; only metadata persistence is implemented.
- DOM snapshot contents are not stored by this adapter; only their SHA-256 digest and summary metadata are emitted.
- Authentication, tenant isolation and migration orchestration are not implemented.
- Hybrid native/WebView discovery is observational; coordinated actions and transitions between the two contexts are not yet generated.
- In-memory mode is intended for tests/local exploration, not multi-process production use.
- Real-device and simulator E2E validation is still required; CI currently covers fake-driver/unit tests.
