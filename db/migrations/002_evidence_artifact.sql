-- Evidence metadata is stored in PostgreSQL; binary objects live in an external object store.
CREATE TABLE IF NOT EXISTS evidence_artifact (
  evidence_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES discovery_session(session_id) ON DELETE CASCADE,
  event_id uuid REFERENCES discovery_event(event_id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('screenshot', 'video', 'dom_snapshot', 'accessibility_tree', 'log', 'network_trace')),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 200),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_uri text NOT NULL CHECK (length(storage_uri) BETWEEN 1 AND 2048),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_artifact_session_time
  ON evidence_artifact(session_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_evidence_artifact_event
  ON evidence_artifact(event_id);
