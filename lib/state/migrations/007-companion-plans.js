/** No content or hashes: a replay fence, result refs and trusted detail lifecycle only. */
export function applyCompanionPlans(db) {
    for (const name of ['companion_memory_plans', 'companion_task_sources']) {
        const existing = db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(name);
        if (existing !== undefined && existing.type !== 'table')
            throw new Error('Companion metadata table conflicts with a ' + existing.type);
    }
    const columns = db.pragma('table_info(companion_memories)');
    if (!columns.some(column => column.name === 'detail_state')) {
        db.exec("ALTER TABLE companion_memories ADD COLUMN detail_state TEXT NOT NULL DEFAULT 'required' CHECK (detail_state IN ('required', 'cold', 'unavailable'))");
        db.exec("UPDATE companion_memories SET detail_state = 'unavailable' WHERE details_unavailable = 1");
    }
    if (!columns.some(column => column.name === 'detail_cold_since'))
        db.exec('ALTER TABLE companion_memories ADD COLUMN detail_cold_since TEXT');
    db.exec(`
CREATE TABLE IF NOT EXISTS companion_memory_plans (
  plan_id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id),
  expected_epoch INTEGER NOT NULL CHECK (expected_epoch >= 0),
  applied_epoch INTEGER NOT NULL CHECK (applied_epoch > expected_epoch),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
  result_refs_json TEXT NOT NULL CHECK (json_valid(result_refs_json) AND json_type(result_refs_json) = 'array'),
  state TEXT NOT NULL CHECK (state = 'applied'),
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_task_sources (
  companion_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  PRIMARY KEY (companion_id, task_id, event_id, source_revision),
  FOREIGN KEY (companion_id, task_id) REFERENCES companion_tasks(companion_id, task_id),
  FOREIGN KEY (companion_id, event_id) REFERENCES events(companion_id, id)
);
CREATE INDEX IF NOT EXISTS companion_task_source_event ON companion_task_sources(companion_id, event_id);
INSERT OR IGNORE INTO companion_task_sources(companion_id,task_id,event_id,source_revision)
  SELECT companion_id,task_id,event_id,source_revision FROM companion_staged_sources WHERE purpose = 'task';
`);
}
