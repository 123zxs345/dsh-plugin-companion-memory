import type Database from 'better-sqlite3';

/** v5 -> v6: revisioned companion domain and references to staged sources; no raw-text copies. */
export function applyCompanionMemory(db: Database.Database): void {
  const columns = db.pragma('table_info(event_metadata)') as { name: string }[];
  if (!columns.some(column => column.name === 'memory_route')) {
    db.exec("ALTER TABLE event_metadata ADD COLUMN memory_route TEXT NOT NULL DEFAULT 'legacy' CHECK (memory_route IN ('legacy', 'staged'))");
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS companion_memories (
  companion_id TEXT NOT NULL REFERENCES companions(id),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  meaning TEXT NOT NULL,
  anchors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(anchors_json) AND json_type(anchors_json) = 'array'),
  view TEXT NOT NULL CHECK (view IN ('user_understanding', 'shared_episode', 'interaction_habit')),
  certainty TEXT NOT NULL CHECK (certainty IN ('explicit', 'inferred')),
  reason TEXT NOT NULL,
  use_when TEXT NOT NULL DEFAULT '',
  avoid_when TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'historical', 'condensed', 'deprioritized', 'discarded', 'forgotten')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  details_unavailable INTEGER NOT NULL DEFAULT 0 CHECK (details_unavailable IN (0, 1)),
  created_at TEXT NOT NULL,
  last_reviewed_at TEXT,
  last_retrieved_at TEXT,
  last_presented_at TEXT,
  PRIMARY KEY (companion_id, id, revision)
);
CREATE TABLE IF NOT EXISTS companion_memory_evidence (
  companion_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  memory_revision INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  source_role TEXT NOT NULL CHECK (source_role IN ('user', 'assistant', 'tool')),
  PRIMARY KEY (companion_id, memory_id, memory_revision, event_id, source_revision),
  FOREIGN KEY (companion_id, memory_id, memory_revision) REFERENCES companion_memories(companion_id, id, revision),
  FOREIGN KEY (companion_id, event_id) REFERENCES events(companion_id, id)
);
CREATE INDEX IF NOT EXISTS companion_evidence_source ON companion_memory_evidence(companion_id, event_id, source_revision);
CREATE TABLE IF NOT EXISTS companion_memory_links (
  companion_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  parent_revision INTEGER NOT NULL,
  child_id TEXT NOT NULL,
  child_revision INTEGER NOT NULL,
  PRIMARY KEY (companion_id, parent_id, parent_revision, child_id, child_revision),
  CHECK (parent_id != child_id OR parent_revision != child_revision),
  FOREIGN KEY (companion_id, parent_id, parent_revision) REFERENCES companion_memories(companion_id, id, revision),
  FOREIGN KEY (companion_id, child_id, child_revision) REFERENCES companion_memories(companion_id, id, revision)
);
CREATE TABLE IF NOT EXISTS memory_index_locations (
  companion_id TEXT NOT NULL REFERENCES companions(id),
  id TEXT NOT NULL,
  bank TEXT NOT NULL,
  bank_kind TEXT NOT NULL CHECK (bank_kind IN ('legacy', 'companion')),
  document_id TEXT NOT NULL,
  operation_id TEXT,
  event_id TEXT,
  source_revision INTEGER CHECK (source_revision >= 0),
  memory_id TEXT,
  memory_revision INTEGER,
  index_state TEXT NOT NULL DEFAULT 'pending' CHECK (index_state IN ('pending', 'indexed', 'failed', 'erased')),
  cleanup_state TEXT NOT NULL DEFAULT 'not-requested' CHECK (cleanup_state IN ('not-requested', 'pending', 'done', 'blocked', 'unknown')),
  PRIMARY KEY (companion_id, id),
  UNIQUE (companion_id, bank, document_id),
  CHECK ((event_id IS NOT NULL AND source_revision IS NOT NULL AND memory_id IS NULL AND memory_revision IS NULL)
    OR (event_id IS NULL AND source_revision IS NULL AND memory_id IS NOT NULL AND memory_revision IS NOT NULL)),
  FOREIGN KEY (companion_id, event_id) REFERENCES events(companion_id, id),
  FOREIGN KEY (companion_id, memory_id, memory_revision) REFERENCES companion_memories(companion_id, id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_locations_operation ON memory_index_locations(companion_id, operation_id) WHERE operation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS companion_tasks (
  companion_id TEXT NOT NULL REFERENCES companions(id),
  task_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed')),
  PRIMARY KEY (companion_id, task_id)
);
CREATE TABLE IF NOT EXISTS companion_staged_sources (
  companion_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('companion', 'task')),
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'ignored', 'compacted', 'erased')),
  staged_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT,
  PRIMARY KEY (companion_id, event_id, source_revision),
  CHECK ((purpose = 'companion' AND task_id IS NULL) OR (purpose = 'task' AND task_id IS NOT NULL)),
  FOREIGN KEY (companion_id, event_id) REFERENCES events(companion_id, id),
  FOREIGN KEY (companion_id, task_id) REFERENCES companion_tasks(companion_id, task_id)
);
CREATE INDEX IF NOT EXISTS companion_staged_pending ON companion_staged_sources(companion_id, status);
`);
  // Both insertion and edge replacement must preserve the revision graph's DAG.
  for (const operation of ['INSERT', 'UPDATE'] as const) {
    db.exec(`
CREATE TRIGGER IF NOT EXISTS companion_links_acyclic_${operation.toLowerCase()}
BEFORE ${operation} ON companion_memory_links
BEGIN
  SELECT RAISE(ABORT, 'Companion memory links must be acyclic') WHERE EXISTS (
    WITH RECURSIVE descendants(id, revision) AS (
      SELECT NEW.child_id, NEW.child_revision
      UNION
      SELECT l.child_id, l.child_revision FROM companion_memory_links l
      JOIN descendants d ON l.parent_id = d.id AND l.parent_revision = d.revision
      WHERE l.companion_id = NEW.companion_id${operation === 'UPDATE' ? ' AND l.rowid != OLD.rowid' : ''}
    ) SELECT 1 FROM descendants WHERE id = NEW.parent_id AND revision = NEW.parent_revision
  );
END;
`);
  }
}
