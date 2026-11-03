import type Database from 'better-sqlite3';

/** v2 baseline schema (also the v0/v1 upgrade path). */
export const BASELINE_DDL = `
CREATE TABLE IF NOT EXISTS companions (id TEXT PRIMARY KEY, seed_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  companion_id TEXT NOT NULL REFERENCES companions(id), id TEXT NOT NULL,
  session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  occurred_at TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL, visibility TEXT NOT NULL,
  tool_verified INTEGER, fingerprint TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
  superseded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (companion_id, id)
);
CREATE INDEX IF NOT EXISTS events_session ON events(companion_id, session_id, occurred_at_ms);
CREATE TABLE IF NOT EXISTS profiles (
  companion_id TEXT NOT NULL REFERENCES companions(id), domain TEXT NOT NULL, key TEXT NOT NULL,
  scope TEXT NOT NULL, value TEXT NOT NULL, certainty TEXT NOT NULL, source_event_id TEXT,
  evidence_quote TEXT NOT NULL, reason TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(companion_id, domain, key, scope)
);
CREATE TABLE IF NOT EXISTS profile_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, companion_id TEXT NOT NULL REFERENCES companions(id),
  domain TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, value TEXT NOT NULL,
  certainty TEXT NOT NULL, source_event_id TEXT, evidence_quote TEXT NOT NULL,
  reason TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS revisions_source ON profile_revisions(companion_id, source_event_id);
CREATE TABLE IF NOT EXISTS memory_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, companion_id TEXT NOT NULL REFERENCES companions(id),
  document_id TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT, lease_until INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_document ON memory_jobs(companion_id, document_id, status);
CREATE TABLE IF NOT EXISTS job_leases (
  token TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES memory_jobs(id), settled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS uncertain_writes (
  companion_id TEXT NOT NULL REFERENCES companions(id), document_id TEXT NOT NULL,
  PRIMARY KEY(companion_id, document_id)
);
`;

/** Apply the v2 baseline. CREATE IF NOT EXISTS keeps the v1 upgrade path intact. */
export function applyInitial(db: Database.Database): void {
  db.exec(BASELINE_DDL);
}
