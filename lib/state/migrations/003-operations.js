/**
 * v2 -> v3: source metadata, per-companion epochs, durable native operation
 * identities and derived-object dependency edges.
 *
 * payload_hash is nullable: once an operation is proven erased the fingerprint of
 * the payload it used to hold is cleared too (it is not content, but it is still a
 * stable identifier of the erased write).
 */
export function applyOperations(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS event_metadata (
  companion_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  subject TEXT NOT NULL,
  mode TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  received_at TEXT NOT NULL,
  session_seq INTEGER NOT NULL DEFAULT 0,
  learning TEXT NOT NULL DEFAULT 'enabled',
  host_ref TEXT,
  channel_ref TEXT,
  tool_receipt_id TEXT,
  PRIMARY KEY (companion_id, event_id),
  FOREIGN KEY (companion_id, event_id) REFERENCES events(companion_id, id)
);
CREATE INDEX IF NOT EXISTS event_metadata_session ON event_metadata(companion_id, session_seq);
CREATE TABLE IF NOT EXISTS companion_epochs (
  companion_id TEXT PRIMARY KEY REFERENCES companions(id),
  state_epoch INTEGER NOT NULL DEFAULT 0,
  deletion_watermark INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS backend_operations (
  companion_id TEXT NOT NULL REFERENCES companions(id),
  operation_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  payload_hash TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_check_at INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  submitted_at INTEGER,
  completed_at INTEGER,
  error_code TEXT,
  cleanup_state TEXT NOT NULL DEFAULT 'not-requested',
  PRIMARY KEY (companion_id, operation_id)
);
CREATE INDEX IF NOT EXISTS operations_due ON backend_operations(state, next_check_at);
CREATE TABLE IF NOT EXISTS derived_dependencies (
  derived_kind TEXT NOT NULL,
  derived_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  PRIMARY KEY (derived_kind, derived_id, source_id, source_revision)
);
CREATE INDEX IF NOT EXISTS dependencies_source ON derived_dependencies(source_id);
CREATE TABLE IF NOT EXISTS tool_receipts (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  state TEXT NOT NULL,
  action_id TEXT,
  idempotency_key TEXT,
  checked_at TEXT NOT NULL,
  result_hash TEXT
);
`);
    // Defensive: a database relabelled as v1 may still carry later columns. Adding
    // only missing columns keeps this migration idempotent for downgrade fixtures.
    const columns = new Set(db.pragma('table_info(events)').map((column) => column.name));
    if (!columns.has('suppressed'))
        db.exec('ALTER TABLE events ADD COLUMN suppressed INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('deprioritized'))
        db.exec('ALTER TABLE events ADD COLUMN deprioritized INTEGER NOT NULL DEFAULT 0');
    // Conservative backfill: a legacy private user statement may be treated as an
    // owner statement. Assistant output stays assistant, tool output stays external,
    // group messages stay third-party. Nothing is upgraded to verified-tool.
    db.exec(`
INSERT OR IGNORE INTO event_metadata(companion_id, event_id, origin, subject, mode, revision, received_at, session_seq, learning)
SELECT companion_id, id,
  CASE role WHEN 'user' THEN 'owner' WHEN 'assistant' THEN 'assistant' ELSE 'external' END,
  CASE
    WHEN role = 'user' AND visibility = 'private' THEN 'owner'
    WHEN role = 'user' THEN 'third-party'
    WHEN role = 'assistant' THEN 'owner'
    ELSE 'unknown'
  END,
  'real', 1, occurred_at, 0, 'enabled'
FROM events;
INSERT OR IGNORE INTO companion_epochs(companion_id) SELECT id FROM companions;
`);
}
