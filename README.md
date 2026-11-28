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

## API

- `GET /health`
- `POST /v1/discovery-sessions`
- `GET /v1/discovery-sessions`
- `GET /v1/discovery-sessions/:sessionId`
- `POST /v1/discovery-sessions/:sessionId/observe` (when an observer is configured)
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
- Authentication, tenant isolation, authorization for session ownership, bucket lifecycle/retention policies and migration orchestration are not implemented.
- The upload URL itself is not persisted as an upload-intent record. Confirmation is bound to the generated evidence ID and session-scoped object key, but callers still require authenticated access control before production exposure.
- Mobilewright native screenshot capture is implemented; video recording and persisted raw DOM snapshots are not yet integrated. DOM snapshot contents are not stored by the adapter; only their SHA-256 digest and summary metadata are emitted.
- Hybrid context attachment is now represented as a directed native-to-WebView `transition_observed` event. This describes the embedded-context relationship found during one observation, not a user-triggered navigation or a verified runtime handoff. The adapter does not yet execute coordinated actions, observe WebView-to-native returns, or correlate context changes across multiple observations.
- In-memory mode is intended for tests/local exploration, not multi-process production use.
- Real-device and simulator E2E validation is still required; CI currently covers fake-driver/unit tests.
