import type Database from 'better-sqlite3';
/** Version old outbox evidence; this changes metadata only, never source bodies or fences. */
export declare function applyOperationProofs(db: Database.Database): void;
