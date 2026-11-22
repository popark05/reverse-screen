-- PostgreSQL baseline schema for Reverse Screen.
-- application_id is text until the shared Application aggregate owns a UUID contract.
CREATE TABLE IF NOT EXISTS discovery_session (
  session_id uuid PRIMARY KEY,
  application_id text NOT NULL CHECK (length(application_id) BETWEEN 1 AND 200),
  platform text NOT NULL CHECK (platform IN ('web', 'android', 'ios', 'hybrid')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('created', 'running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS discovery_event (
  event_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES discovery_session(session_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type IN (
    'screen_observed', 'element_observed', 'action_candidate', 'action_executed',
    'transition_observed', 'assertion_observed', 'error', 'session_marker'
  )),
  occurred_at timestamptz NOT NULL,
  platform text NOT NULL CHECK (platform IN ('web', 'android', 'ios', 'hybrid')),
  screen_id uuid,
  state_id uuid,
  transition_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_discovery_event_session_time
  ON discovery_event(session_id, occurred_at);
