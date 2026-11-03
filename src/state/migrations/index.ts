import { copyFileSync, unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { applyInitial } from './001-initial.ts';
import { applyOperations } from './003-operations.ts';
import { applyEvidence } from './004-evidence.ts';
import { applyOperationsRepair } from './005-operations-repair.ts';
import { applyCompanionMemory } from './006-companion-memory.ts';
import { applyCompanionPlans } from './007-companion-plans.ts';
import { applyOperationProofs } from './008-operation-proofs.ts';
import { applyMemorySummary } from './009-memory-summary.ts';

export const CURRENT_SCHEMA_VERSION = 9;
export interface MigrationWarning {
  code: 'snapshot-cleanup-failed';
  snapshotPath: string;
  message: string;
}
const MIN_SUPPORTED_VERSION = 0;

export function isSupportedVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= MIN_SUPPORTED_VERSION && version <= CURRENT_SCHEMA_VERSION;
}

function currentVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (!isSupportedVersion(version)) throw new Error('Unsupported state schema version');
  return version;
}

/**
 * Recoverable pre-upgrade snapshot. The caller has already checkpointed the WAL,
 * so the main database file is complete. A failed migration transaction rolls
 * back to the original version and the snapshot remains available for recovery.
 */
function snapshot(db: Database.Database, path: string, version: number): string | null {
  if (version <= 0 || path === ':memory:') return null;
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
function discardSnapshot(target: string | null, warnings: MigrationWarning[]): void {
  if (target === null) return;
  try {
    unlinkSync(target);
  } catch (error) {
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
export function migrate(db: Database.Database, path: string, warnings: MigrationWarning[] = []): number {
  const initial = currentVersion(db);
  if (initial === CURRENT_SCHEMA_VERSION) return initial;
  const snapshotPath = snapshot(db, path, initial);
  db.transaction(() => {
    // Re-read under the write lock: another process may have migrated first.
    let version = currentVersion(db);
    if (version === CURRENT_SCHEMA_VERSION) return;
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
    if(version < 8){applyOperationProofs(db);db.pragma('user_version = 8');version = 8;}
    if(version < 9){applyMemorySummary(db);db.pragma('user_version = 9');}
  }).immediate();
  discardSnapshot(snapshotPath, warnings);
  return currentVersion(db);
}
