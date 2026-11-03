import type Database from 'better-sqlite3';
export declare const CURRENT_SCHEMA_VERSION = 9;
export interface MigrationWarning {
    code: 'snapshot-cleanup-failed';
    snapshotPath: string;
    message: string;
}
export declare function isSupportedVersion(version: number): boolean;
/** Run the whole migration chain in one transaction; version 0 also bootstraps. */
export declare function migrate(db: Database.Database, path: string, warnings?: MigrationWarning[]): number;
