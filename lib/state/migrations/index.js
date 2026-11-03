import { copyFileSync, unlinkSync } from 'node:fs';
import { applyInitial } from './001-initial.js';
import { applyOperations } from './003-operations.js';
import { applyEvidence } from './004-evidence.js';
import { applyOperationsRepair } from './005-operations-repair.js';
import { applyCompanionMemory } from './006-companion-memory.js';
import { applyCompanionPlans } from './007-companion-plans.js';
import { applyOperationProofs } from './008-operation-proofs.js';
import { applyMemorySummary } from './009-memory-summary.js';
export const CURRENT_SCHEMA_VERSION = 9;
const MIN_SUPPORTED_VERSION = 0;
export function isSupportedVersion(version) {
    return Number.isSafeInteger(version) && version >= MIN_SUPPORTED_VERSION && version <= CURRENT_SCHEMA_VERSION;
}
function currentVersion(db) {
    const version = db.pragma('user_version', { simple: true });
    if (!isSupportedVersion(version))
        throw new Error('Unsupported state schema version');
    return version;
}
/**
 * Recoverable pre-upgrade snapshot. The caller has already checkpointed the WAL,
 * so the main database file is complete. A failed migration transaction rolls
 * back to the original version and the snapshot remains available for recovery.
 */
function snapshot(db, path, version) {
    if (version <= 0 || path === ':memory:')
        return null;
    db.pragma('wal_checkpoint(TRUNCATE)');
    const target = `${path}.v${version}.snapshot`;
    copyFileSync(path, target);
    return target;
}
/**
 * A snapshot is a plaintext pre-upgrade copy: it exists only to recover a failed
 * upgrade. Once the new schema is committed it must not outlive the migration,
 * or erased content would stay readable in the backup.
 */
function discardSnapshot(target, warnings) {
    if (target === null)
        return;
    try {
        unlinkSync(target);
    }
    catch (error) {
        // The upgrade itself succeeded; a leftover plaintext snapshot is not worth failing
        // the open, but it must be observable: it still contains pre-erasure content.
        warnings.push({
            code: 'snapshot-cleanup-failed',
            snapshotPath: target,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
/** Run the whole migration chain in one transaction; version 0 also bootstraps. */
export function migrate(db, path, warnings = []) {
    const initial = currentVersion(db);
    if (initial === CURRENT_SCHEMA_VERSION)
        return initial;
    const snapshotPath = snapshot(db, path, initial);
    db.transaction(() => {
        // Re-read under the write lock: another process may have migrated first.
        let version = currentVersion(db);
        if (version === CURRENT_SCHEMA_VERSION)
            return;
        if (version < 2) {
            applyInitial(db);
            db.pragma('user_version = 2');
            version = 2;
        }
        if (version < 3) {
            applyOperations(db);
            db.pragma('user_version = 3');
            version = 3;
        }
        if (version < 4) {
            applyEvidence(db);
            db.pragma('user_version = 4');
            version = 4;
        }
        if (version < 5) {
            applyOperationsRepair(db);
            db.pragma('user_version = 5');
            version = 5;
        }
        if (version < 6) {
            applyCompanionMemory(db);
            db.pragma('user_version = 6');
            version = 6;
        }
        if (version < 7) {
            applyCompanionPlans(db);
            db.pragma('user_version = 7');
            version = 7;
        }
        if (version < 8) {
            applyOperationProofs(db);
            db.pragma('user_version = 8');
            version = 8;
        }
        if (version < 9) {
            applyMemorySummary(db);
            db.pragma('user_version = 9');
        }
    }).immediate();
    discardSnapshot(snapshotPath, warnings);
    return currentVersion(db);
}
