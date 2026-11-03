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
export declare function applyOperationsRepair(db: Database.Database): void;
