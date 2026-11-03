import type Database from 'better-sqlite3';
import type { SourceEvent } from '../contracts.ts';
import type { CompanionMemory, CompanionMemoryEvidence, CompanionMemoryPlan, CompanionMemoryPlanResult, CompanionMemoryRevisionRef, CompanionSourceRef, CompanionTaskState, DetailCleanupCheck, ListCompanionMemoriesOptions, ListPendingSourcesOptions, MemoryIndexLocation, PendingCompanionSource, RegisterMemoryIndexLocation } from './companion-types.ts';
/** StateStore calls this only inside its existing source invalidation transaction. */
export declare function invalidateCompanionSourcesTx(db: Database.Database, companionId: string, eventIds: readonly string[], mode: 'erase' | 'suppress'): void;
/** This is an evidence-admission rule, independent of the legacy document guard. */
export declare function isCompanionSourceEligible(event: SourceEvent): boolean;
/** Shares StateStore's private connection and lifetime; never opens or exposes a database. */
export declare class CompanionMemoryStore {
    #private;
    constructor(db: Database.Database);
    /** Re-read current material and its complete evidence/DAG. Never returns staged source text. */
    materialSnapshot(companionId: string, reference: CompanionMemoryRevisionRef): {
        memory: CompanionMemory;
        content: string;
        payloadHash: string;
    } | null;
    indexableMemoryRefs(companionId: string): CompanionMemoryRevisionRef[];
    /** Validate the whole DAG and capture a disclosure page under one write lock. */
    disclosureSnapshot(companionId: string, reference: CompanionMemoryRevisionRef, rawOffset?: number): {
        memory: CompanionMemory;
        sourceRefs: {
            eventId: string;
            sourceRevision: number;
        }[];
        sources: {
            eventId: string;
            sourceRevision: number;
            role: "assistant" | "tool" | "user";
            content: string | null;
            occurredAt: string;
        }[];
        nextOffset: number | null;
    };
    /** Validates and commits a whole model plan under one SQLite write lock. Replays are explicit errors. */
    applyPlan(input: CompanionMemoryPlan): CompanionMemoryPlanResult;
    listMemories(companionId: string, options?: ListCompanionMemoriesOptions): CompanionMemory[];
    /** Stable bounded backfill page. Eligibility checks do not assign semantic importance. */
    listMemoriesWithoutSummary(companionId: string, limit?: number, excluded?: readonly CompanionMemoryRevisionRef[]): CompanionMemory[];
    /** All current model-classified profile entries, independent of the general catalog page limit. */
    listProfileMemories(companionId: string): CompanionMemory[];
    getMemory(companionId: string, refOrId: CompanionMemoryRevisionRef | string): CompanionMemory | null;
    evidenceFor(companionId: string, reference: CompanionMemoryRevisionRef): CompanionMemoryEvidence[];
    parentsFor(companionId: string, reference: CompanionMemoryRevisionRef): CompanionMemoryRevisionRef[];
    /** Trusted user pin control; exact current revision, with plan invalidation on change. */
    pinMemory(companionId: string, reference: CompanionMemoryRevisionRef, pinned: boolean): boolean;
    recordRetrieved(companionId: string, references: readonly CompanionMemoryRevisionRef[]): void;
    recordPresented(companionId: string, references: readonly CompanionMemoryRevisionRef[]): void;
    /** Trusted lifecycle control only; this neither claims raw text was removed nor performs erasure. */
    setDetailState(companionId: string, reference: CompanionMemoryRevisionRef, state: 'required' | 'cold'): boolean;
    /** Event-wide eligibility: a summary's references never authorize clearing another use's original text. */
    checkDetailCleanup(companionId: string, reference: CompanionSourceRef): DetailCleanupCheck;
    /** Internal opaque routing handle, never derived from model content or a backend algorithm. */
    registerIndexLocation(companionId: string, input: RegisterMemoryIndexLocation): MemoryIndexLocation;
    getIndexLocation(companionId: string, handle: string): MemoryIndexLocation | null;
    findIndexLocation(companionId: string, bank: string, documentId: string): MemoryIndexLocation | null;
    indexLocationForOperation(companionId: string, operationId: string): MemoryIndexLocation | null;
    listIndexLocations(companionId: string): MemoryIndexLocation[];
    ensureIndexLocation(companionId: string, input: RegisterMemoryIndexLocation): MemoryIndexLocation;
    updateIndexLocation(companionId: string, handle: string, patch: Partial<Pick<MemoryIndexLocation, 'operationId' | 'indexState' | 'cleanupState'>>): MemoryIndexLocation;
    /** Event-wide across all revisions and historical DAG edges; erasure must not depend on current bodies. */
    indexLocationsForEvents(companionId: string, eventIds: readonly string[]): MemoryIndexLocation[];
    indexLocationsForSource(companionId: string, reference: CompanionSourceRef): MemoryIndexLocation[];
    /** Trusted task orchestration: one real source revision may support several independent tasks. */
    linkTaskSource(companionId: string, taskId: string, reference: CompanionSourceRef): boolean;
    /** Ordered by source occurredAt, then append order for ties; returns complete text. */
    listPending(companionId: string, options?: ListPendingSourcesOptions): PendingCompanionSource[];
    /** Total UTF-8 body bytes over every currently valid pending source, independent of page size. */
    pendingBytes(companionId: string): number;
    /** All references must still exist at the supplied revisions; any invalid item rolls back the batch. */
    markReviewed(companionId: string, sources: readonly CompanionSourceRef[]): number;
    /** Returns whether state changed. Task changes invalidate plans through the shared epoch. */
    setTaskState(companionId: string, taskId: string, state: CompanionTaskState): boolean;
}
