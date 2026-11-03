import type Database from 'better-sqlite3';

/** Retrieval summaries are authored by the model; migrations never infer them from existing text. */
export function applyMemorySummary(db: Database.Database): void {
  db.exec('ALTER TABLE companion_memories ADD COLUMN summary TEXT');
}
