import type Database from 'better-sqlite3';
/**
 * v3 -> v4: evidence-backed, temporal profile facts. Existing profiles become a
 * materialized current view with exactly one fact version and (when the old row
 * has a real source) exactly one evidence row. No additional support is invented.
 */
export declare function applyEvidence(db: Database.Database): void;
