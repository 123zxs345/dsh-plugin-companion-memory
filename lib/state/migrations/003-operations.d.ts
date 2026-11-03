import type Database from 'better-sqlite3';
/**
 * v2 -> v3: source metadata, per-companion epochs, durable native operation
 * identities and derived-object dependency edges.
 *
 * payload_hash is nullable: once an operation is proven erased the fingerprint of
 * the payload it used to hold is cleared too (it is not content, but it is still a
 * stable identifier of the erased write).
 */
export declare function applyOperations(db: Database.Database): void;
