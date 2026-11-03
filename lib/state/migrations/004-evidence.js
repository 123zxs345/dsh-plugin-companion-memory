/**
 * v3 -> v4: evidence-backed, temporal profile facts. Existing profiles become a
 * materialized current view with exactly one fact version and (when the old row
 * has a real source) exactly one evidence row. No additional support is invented.
 */
export function applyEvidence(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS profile_candidates (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  domain TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL,
  certainty TEXT NOT NULL,
  intent TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  expires_at TEXT,
  reason TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_status ON profile_candidates(companion_id, status);
CREATE TABLE IF NOT EXISTS profile_fact_versions (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  domain TEXT NOT NULL,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  certainty TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  valid_from TEXT,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  materialized INTEGER NOT NULL DEFAULT 0,
  primary_source_id TEXT
);
CREATE INDEX IF NOT EXISTS facts_current ON profile_fact_versions(companion_id, domain, key, scope, status);
CREATE INDEX IF NOT EXISTS facts_revision ON profile_fact_versions(companion_id, domain, key, scope, revision);
CREATE TABLE IF NOT EXISTS profile_evidence (
  fact_version_id TEXT NOT NULL REFERENCES profile_fact_versions(id),
  event_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  receipt_id TEXT,
  result_hash TEXT,
  PRIMARY KEY (fact_version_id, event_id, source_revision)
);
CREATE INDEX IF NOT EXISTS evidence_event ON profile_evidence(event_id, source_revision);
CREATE TABLE IF NOT EXISTS forget_requests (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  selector_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  state_epoch INTEGER NOT NULL,
  local_status TEXT NOT NULL,
  backend_status TEXT NOT NULL,
  operation_payload_status TEXT NOT NULL,
  history_status TEXT NOT NULL,
  backup_status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
    // One fact version per existing profile row; the materialized view stays the
    // current-value projection of that version.
    db.exec(`
INSERT INTO profile_fact_versions(id, companion_id, domain, key, scope, value, certainty, reason,
  valid_from, valid_to, recorded_at, revision, status, materialized, primary_source_id)
SELECT 'legacy-' || lower(hex(randomblob(16))), p.companion_id, p.domain, p.key, p.scope, p.value, p.certainty, p.reason,
  CASE WHEN p.source_event_id IS NULL THEN NULL ELSE p.updated_at END, NULL, p.updated_at,
  p.version, 'active', 1, p.source_event_id
FROM profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM profile_fact_versions f
  WHERE f.companion_id = p.companion_id AND f.domain = p.domain AND f.key = p.key
    AND f.scope = p.scope AND f.materialized = 1 AND f.revision = p.version
);
INSERT OR IGNORE INTO profile_evidence(fact_version_id, event_id, source_revision, quote)
SELECT f.id, p.source_event_id,
  COALESCE((SELECT revision FROM event_metadata m WHERE m.companion_id = p.companion_id AND m.event_id = p.source_event_id), 1),
  p.evidence_quote
FROM profiles p
JOIN profile_fact_versions f ON f.companion_id = p.companion_id AND f.domain = p.domain
  AND f.key = p.key AND f.scope = p.scope AND f.materialized = 1 AND f.revision = p.version
WHERE p.source_event_id IS NOT NULL;
INSERT OR IGNORE INTO derived_dependencies(derived_kind, derived_id, source_id, source_revision)
SELECT 'profile_fact', e.fact_version_id, e.event_id, e.source_revision
FROM profile_evidence e;
`);
    // A legacy row is only as trustworthy as the event that supports it. Facts whose
    // only backing was a non-owner, non-private or non-real event are downgraded, and
    // the materialized view may not keep showing them. Rows with no source at all are
    // left alone: the migration does not invent (or destroy) provenance.
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
