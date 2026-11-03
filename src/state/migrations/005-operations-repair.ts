import type Database from 'better-sqlite3';

/**
 * v4 -> v5: repair the consequences of two v4 defects.
 *
 * 1. Legacy profiles whose source event had an empty quote were migrated without an
 *    evidence row, so forgetting that event left the belief visible. The evidence row
 *    (with quote '') is the only honest record that the event supported the value, so
 *    it is inserted for existing rows and the trust downgrade runs again.
 * 2. backend_operations.payload_hash was declared nullable in v3, but a database that
 *    ran an older v4 build may still carry a NOT NULL column. The table is rebuilt so
 *    an erased operation can really clear the fingerprint of its payload.
 */
export function applyOperationsRepair(db: Database.Database): void {
  const columns = db.pragma('table_info(backend_operations)') as { name: string; notnull: number }[];
  const payload = columns.find((column) => column.name === 'payload_hash');
  if (payload !== undefined && payload.notnull === 1) {
    db.exec(`
CREATE TABLE backend_operations_v5 (
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
INSERT INTO backend_operations_v5(companion_id, operation_id, document_id, source_revision, payload_hash, state, attempts, next_check_at, last_checked_at, submitted_at, completed_at, error_code, cleanup_state)
SELECT companion_id, operation_id, document_id, source_revision, payload_hash, state, attempts, next_check_at, last_checked_at, submitted_at, completed_at, error_code, cleanup_state FROM backend_operations;
DROP TABLE backend_operations;
ALTER TABLE backend_operations_v5 RENAME TO backend_operations;
CREATE INDEX IF NOT EXISTS operations_due ON backend_operations(state, next_check_at);
`);
  }
  // A sourced legacy profile must have the evidence row that lets a later revocation
  // find it. Existing v4 databases may have migrated it without one when the quote
  // was empty; the empty quote still records that the event supported the value.
  db.exec(`
INSERT OR IGNORE INTO profile_evidence(fact_version_id, event_id, source_revision, quote)
SELECT f.id, p.source_event_id,
  COALESCE((SELECT revision FROM event_metadata m WHERE m.companion_id = p.companion_id AND m.event_id = p.source_event_id), 1),
  p.evidence_quote
FROM profiles p
JOIN profile_fact_versions f ON f.companion_id = p.companion_id AND f.domain = p.domain
  AND f.key = p.key AND f.scope = p.scope AND f.materialized = 1 AND f.revision = p.version
WHERE p.source_event_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM profile_evidence e WHERE e.fact_version_id = f.id AND e.event_id = p.source_event_id);
INSERT OR IGNORE INTO derived_dependencies(derived_kind, derived_id, source_id, source_revision)
SELECT 'profile_fact', e.fact_version_id, e.event_id, e.source_revision FROM profile_evidence e;
`);
  // Re-run the v4 trust downgrade: evidence that had been silently missing can now
  // prove that a materialized fact was never supported by a trusted owner statement.
  db.exec(`
UPDATE profile_fact_versions SET status = 'suppressed', materialized = 0, value = '', primary_source_id = NULL
WHERE materialized = 1 AND EXISTS (
  SELECT 1 FROM profile_evidence e
  WHERE e.fact_version_id = profile_fact_versions.id AND e.receipt_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM events ev
    JOIN event_metadata m ON m.companion_id = ev.companion_id AND m.event_id = ev.id
    WHERE ev.companion_id = profile_fact_versions.companion_id AND ev.id = e.event_id
      AND ev.role = 'user' AND ev.visibility = 'private'
      AND ev.forgotten = 0 AND ev.suppressed = 0 AND ev.superseded = 0
      AND m.origin = 'owner' AND m.subject = 'owner' AND m.mode = 'real' AND m.learning = 'enabled'
  )
);
DELETE FROM profiles
WHERE EXISTS (
  SELECT 1 FROM profile_fact_versions f
  WHERE f.companion_id = profiles.companion_id AND f.domain = profiles.domain
    AND f.key = profiles.key AND f.scope = profiles.scope
    AND f.status = 'suppressed' AND f.materialized = 0
    AND EXISTS (SELECT 1 FROM profile_evidence e WHERE e.fact_version_id = f.id)
);
`);
}