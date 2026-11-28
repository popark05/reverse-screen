# Reverse Screen

Runtime discovery engine for web, mobile and hybrid applications. Reverse Screen observes running applications and produces normalized screen, state, element, action and transition data for downstream wireflow review and QA authoring.

## Development

- Node.js 22.12+
- PostgreSQL 14+ (optional for local in-memory development)
- Playwright for web discovery
- Mobilewright for native Android/iOS and embedded WebView discovery
- S3-compatible Object Storage for binary evidence (optional)

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
- each discovered WebView screen carries `parent_screen_id` and `parent_state_id` references to the native host context
- a `transition_observed` event with `transition_kind = "context_attachment"` links the native host screen/state to the embedded WebView screen/state, with a stable `transition_id`
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

The endpoint moves the session through `created -> running -> completed` and stores normalized events. When `S3_BUCKET` is configured, it also captures a PNG screenshot through `screen.screenshot()`, uploads it to Object Storage, verifies the stored checksum/size/content type, registers the EvidenceArtifact, and adds its ID to the native `screen_observed` event. Set `MOBILE_DISCOVERY_MAX_EVIDENCE_BYTES` to cap screenshot size (default 20 MiB). If evidence storage fails, the observation is marked failed. A native-only app simply produces no WebView events. `MOBILE_DISCOVERY_MAX_ELEMENTS` bounds native elements (default 300); `MOBILE_DISCOVERY_MAX_WEBVIEW_ELEMENTS` bounds semantic WebView elements (default 200).

## Coordinated Mobile Actions

After the initial discovery session reaches `completed`, an enabled Mobilewright observer can execute one locator-based action and immediately run a fresh observation:

```http
POST /v1/discovery-sessions/{sessionId}/actions
Content-Type: application/json

{
  "context_type": "webview",
  "action": "tap",
  "locator_strategy": "role_name",
  "locator_role": "button",
  "locator_name": "Continue",
  "webview_index": 0,
  "screen_id": "screen-uuid-from-action-candidate",
  "state_id": "state-uuid-from-action-candidate",
  "target_element_key": "web-element:stable-key"
}
```

Supported actions are `tap` and `fill`. Locator strategies are `label`, `test_id`, and `role_name`. Native targets use Mobilewright native locators; WebView targets use the Playwright-compatible Page locators. Requests must reference the latest matching `action_candidate` event by `screen_id`, `state_id`, and `target_element_key`; stale or unobserved targets are rejected. The response contains an `action_executed` event linked to that source and post-action observation events with session-wide sequence numbers. Text supplied to `fill` is used only for execution and is never copied into events.

Action execution is disabled by default. Set `MOBILE_ACTION_EXECUTION_ENABLED=true` to enable it, and configure an explicit `authorizeMobileAction` policy when building the server. If no authorizer is configured, or it rejects or errors, the API returns `403` and does not execute the action. The policy receives the persisted session, the action metadata without `input_value`, and request headers so the hosting service can apply its authenticated principal, session ownership, tenant, context, action, and locator rules. Do not trust identity headers unless trusted authentication middleware has validated them. The request schema already limits actions to `tap`/`fill`, contexts to `native`/`webview`, and locator strategies to `label`/`test_id`/`role_name`; deployments should further restrict these per tenant and application. Requests are serialized per session. This endpoint remains privileged and must not be exposed to untrusted clients; the repository does not provide an authentication system or tenant model itself.

## Evidence Object Storage

Evidence binaries are stored in an S3-compatible object store; PostgreSQL stores only metadata and the stable `s3://bucket/key` URI. The API issues short-lived presigned URLs so clients upload/download bytes directly without routing client payloads through the API server. When Mobilewright discovery is enabled together with S3 storage, the adapter captures a native PNG screenshot and the discovery API uploads it server-side, verifies its checksum, registers EvidenceArtifact metadata, and links the evidence ID to the corresponding native screen event.

### Configuration

Set `S3_BUCKET` to enable the storage endpoints. AWS credentials use the standard SDK credential provider chain unless explicit credentials are supplied.

| Variable | Default | Description |
| --- | --- | --- |
| `S3_BUCKET` | unset | Enables S3 storage and names the bucket |
| `S3_REGION` | `us-east-1` | AWS region / S3-compatible region |
| `S3_ENDPOINT` | unset | Optional custom endpoint, e.g. MinIO |
| `S3_ACCESS_KEY_ID` | unset | Optional explicit access key |
| `S3_SECRET_ACCESS_KEY` | unset | Optional explicit secret |
| `S3_FORCE_PATH_STYLE` | `false` | Set `true` for MinIO/path-style endpoints |
| `S3_PRESIGN_TTL_SECONDS` | `300` | Upload URL lifetime |
| `S3_DOWNLOAD_TTL_SECONDS` | `300` | Download URL lifetime |

Example MinIO configuration:

```bash
S3_BUCKET=reverse-screen \
S3_ENDPOINT=http://localhost:9000 \
S3_REGION=us-east-1 \
S3_ACCESS_KEY_ID=minioadmin \
S3_SECRET_ACCESS_KEY=minioadmin \
S3_FORCE_PATH_STYLE=true \
npm start
```

The bucket must exist before the API starts. Configure bucket CORS to permit browser clients to send `PUT` requests with the returned `Content-Type` and `x-amz-checksum-sha256` headers.

### Upload protocol

1. Request an upload URL with evidence metadata.
2. Upload the raw bytes directly to the returned URL using the exact returned headers.
3. Confirm the upload. The API performs `HeadObject` and verifies byte size, content type and the S3 SHA-256 checksum before registering metadata.

```http
POST /v1/evidence-artifacts/upload-url
Content-Type: application/json

{
  "session_id": "discovery-session-uuid",
  "kind": "screenshot",
  "content_type": "image/png",
  "byte_size": 1024,
  "sha256": "<64-character lowercase SHA-256 hex>",
  "captured_at": "2026-11-27T00:00:00.000Z"
}
```

The response contains `evidence_id`, `upload_url`, `method: "PUT"`, `required_headers`, stable `storage_uri`, and URL lifetime. The client must send the returned headers unchanged when uploading.

After the PUT succeeds:

```http
POST /v1/evidence-artifacts/{evidenceId}/confirm
Content-Type: application/json

{
  "session_id": "discovery-session-uuid",
  "kind": "screenshot",
  "content_type": "image/png",
  "byte_size": 1024,
  "sha256": "<same SHA-256 hex>",
  "captured_at": "2026-11-27T00:00:00.000Z"
}
```

Only a verified object is registered as an EvidenceArtifact. A missing object returns `409`; mismatched size, content type or checksum returns `422`. The evidence ID returned during URL creation is the ID used for confirmation.

### Download protocol

```http
GET /v1/evidence-artifacts/{evidenceId}/download-url
```

Returns a short-lived `download_url`. The API persists neither presigned URL; only the stable `s3://bucket/key` URI is stored.

### Metadata-only compatibility API

- `POST /v1/evidence-artifacts` — register externally uploaded metadata (legacy/integration path)
- `GET /v1/evidence-artifacts/:evidenceId` — retrieve metadata
- `GET /v1/discovery-sessions/:sessionId/evidence` — list session evidence

Supported kinds: `screenshot`, `video`, `dom_snapshot`, `accessibility_tree`, `log`, `network_trace`.

### QA Platform service authentication

Set `REVERSE_SCREEN_QA_SERVICE_TOKEN` to a cryptographically random secret of at least 32 bytes in Reverse Screen, and set the same value as `REVERSE_SCREEN_SERVICE_TOKEN` in QA Platform. Keep it in deployment secret storage, rotate both deployments together, and use TLS outside local development. The evidence metadata, session evidence-list, and signed download-URL read endpoints require this bearer token. They return `503` when service authentication is not configured and `401` for a missing or invalid token. Other Reverse Screen API routes are not covered by this service-token check.

## API

- `GET /health`
- `POST /v1/discovery-sessions`
- `GET /v1/discovery-sessions`
- `GET /v1/discovery-sessions/:sessionId`
- `POST /v1/discovery-sessions/:sessionId/observe` (when an observer is configured)
- `POST /v1/discovery-sessions/:sessionId/actions` (opt-in Mobilewright action execution)
- `POST /v1/discovery-sessions/:sessionId/transitions`
- `POST /v1/discovery-events`
- `GET /v1/discovery-sessions/:sessionId/events`
- `POST /v1/evidence-artifacts/upload-url`
- `POST /v1/evidence-artifacts/:evidenceId/confirm`
- `GET /v1/evidence-artifacts/:evidenceId/download-url`
- `POST /v1/evidence-artifacts`
- `GET /v1/evidence-artifacts/:evidenceId`
- `GET /v1/discovery-sessions/:sessionId/evidence`

Event ingestion is idempotent by `event_id`; PostgreSQL additionally enforces unique sequence numbers within a session.

## Current boundaries

- Client-originated evidence uses presigned upload/download URLs. Mobilewright discovery can additionally upload its captured native screenshot from the API process; Playwright web discovery does not yet capture screenshots through this evidence pipeline.
- SHA-256 verification depends on the object store returning the S3 `ChecksumSHA256` field from `HeadObject`; the implementation rejects objects where that checksum is unavailable.
- The host application must provide authenticated identity and configure `authorizeMobileAction` to enforce session ownership, tenant isolation, and its action policy. The API denies mobile actions when the authorizer is absent or rejects. Other API routes do not gain authentication from this hook.
- The upload URL itself is not persisted as an upload-intent record. Confirmation is bound to the generated evidence ID and session-scoped object key. Upload and mutation routes still require authenticated access control before production exposure.
- Mobilewright native screenshot capture is implemented; video recording and persisted raw DOM snapshots are not yet integrated. DOM snapshot contents are not stored by the adapter; only their SHA-256 digest and summary metadata are emitted.

- Repeated calls to the Mobilewright adapter within the same discovery session retain an in-memory WebView context instance ID by WebView slot. They emit `context_persisted` when that slot is observed again and `context_detachment` when a successful enumeration no longer contains it. These lifecycle events describe observed presence/absence only; slot reuse, navigation causality, and user-triggered return-to-native behavior are not verified.
- The lifecycle tracker is process-local and adapter-instance-local. The HTTP observe endpoint performs the initial observation; action requests then trigger a fresh post-action observation and append its events to the same session.

- Mobile action execution is opt-in via `MOBILE_ACTION_EXECUTION_ENABLED=true` and an explicit `authorizeMobileAction` policy. Missing, rejecting, or failing authorization denies execution; fill values are omitted from the policy context and discovery events. The host must supply trusted authentication and enforce session ownership, tenant isolation, and application-specific action policy. Other API routes remain unauthenticated.
- In-memory mode is intended for tests/local exploration, not multi-process production use.
- A live native-action smoke check passed on iPhone 17 Pro (iOS 26.3) and Samsung SM-N981N (Android), using the built-in Settings app to observe, tap a discovered navigation control, and observe the changed screen. Target-application flows, hybrid WebView actions, and CI coverage on mobile devices still require validation; automated tests currently use fake drivers.
