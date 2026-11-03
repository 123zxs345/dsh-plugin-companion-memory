import type Database from 'better-sqlite3';
/** Retrieval summaries are authored by the model; migrations never infer them from existing text. */
export declare function applyMemorySummary(db: Database.Database): void;
