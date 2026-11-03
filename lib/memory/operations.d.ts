import type { AsyncOperationBackend, BackendOperation, SourceEvent } from '../contracts.ts';
import { StateStore } from '../state/store.ts';
import type { MemoryIndexLocation } from './companion-types.ts';
export interface MaterialDocument {
    companionId: string;
    handle: string;
    bank: string;
    documentId: string;
    revision: number;
    content: string;
    payloadHash: string;
}
/** Local pre-POST refusal, never inferred from a remote HTTP response. */
export declare class MaterialWriteNotAttemptedError extends Error {
    readonly status?: number;
    constructor(cause: unknown);
}
/** Material eligibility is called again under the existing durable claim transaction. */
export interface MaterialDocumentPort {
    read(operation: BackendOperation): MaterialDocument | null;
    allowed(operation: BackendOperation): boolean;
    shouldErase(companionId: string, handle: string): boolean;
    submit(document: MaterialDocument, operationId: string): Promise<{
        operationId: string;
        state: 'submitted' | 'processing';
    }>;
    deleteDocument(companionId: string, handle: string): Promise<void>;
}
export type LocatedDeleteBackend = AsyncOperationBackend & {
    deleteLocatedDocument?: (location: MemoryIndexLocation) => Promise<void>;
};
/** A location handle is never guessed to be an event ID when a backend lacks this capability. */
export declare function deleteLocatedDocument(backend: LocatedDeleteBackend, location: MemoryIndexLocation): Promise<void>;
export declare const MAX_POLL_BATCH = 100;
/** 2s, 5s, 10s, 30s, then stay at 30s. */
export declare const OP_POLL_BACKOFF_MS: readonly number[];
/** Hash of everything that would change what the backend stores for one source revision. */
export declare function retainPayloadHash(event: SourceEvent): string;
/** Same companion, document, source revision and payload always map to the same durable operation ID. */
export declare function operationIdFor(companionId: string, documentId: string, sourceRevision: number, payloadHash: string): string;
/** HTTP status carried by an adapter error, if any. Unknown objects and timeouts have none. */
export declare function backendHttpStatus(error: unknown): number | undefined;
/** Only a definite 4xx (not 408/429) proves the backend rejected the request; everything else stays uncertain. */
export declare function isDefiniteBackendRejection(error: unknown): boolean;
/**
 * True only when no write can still reach the backend after cleanup.
 * Proofs are a backend-guaranteed quiescent cancellation of an acknowledged
 * submission (never a cooperative cancel response), a poll that
 * already observed the terminal `completed` state (`completedAt` is set only
 * after the backend finished the write), or a submission that was never
 * attempted at all (`submittedAt === null` and `attempts === 0`). None of the
 * weaker conditions is enough: an ambiguous submit timeout has
 * `submittedAt === null` while the payload may already be in flight, and a
 * successful submission also has `attempts === 0` while the write is real.
 * An unacknowledged POST can arrive after a premature cancellation response.
 * A terminal operation may legitimately refuse a late cancel with 409/404, so
 * cancellation cannot be the only accepted proof.
 */
export declare function writeSettled(operation: BackendOperation, quiescentCancellation: boolean): boolean;
export declare function submissionInFlight(operation: BackendOperation): boolean;
/** Cleanup retries must not manufacture evidence that a POST was attempted. */
export declare function nextCleanupAttempts(operation: BackendOperation): number;
export interface SubmitCounts {
    submitted: number;
    failed: number;
    unknown: number;
    erased: number;
}
export interface PollCounts {
    polled: number;
    completed: number;
    failed: number;
    unknown: number;
    cleanupRequested: number;
}
export interface CleanupCounts {
    cleaned: number;
    erased: number;
    unknown: number;
    blocked: number;
}
export interface RunCounts {
    poll: PollCounts;
    cleanup: CleanupCounts;
}
export type OperationCleanupResult = 'erased' | 'already-erased' | 'unknown' | 'blocked';
/** One cleanup proof for both schedulers. Keep upstream evidence until the write is actually settled. */
export declare function cleanupOperationPayload(store: StateStore, backend: AsyncOperationBackend, initial: BackendOperation, now: number, backoffMs: (attempts: number) => number, beforeErased?: (operation: BackendOperation) => Promise<void>): Promise<OperationCleanupResult>;
/**
 * Drives the durable async-operation state machine over StateStore rows:
 * pending -> submitted -> processing -> completed, with failed only for a
 * definite backend rejection and unknown for timeouts or ambiguous answers.
 * Submission, polling and cleanup are one-at-a-time (serial), batch-capped at
 * MAX_POLL_BATCH, and never call the backend for an empty queue.
 */
export declare class OperationCoordinator {
    private readonly store;
    private readonly backend;
    private readonly clock;
    private readonly materials?;
    constructor(store: StateStore, backend: AsyncOperationBackend, clock?: () => number, materials?: MaterialDocumentPort);
    backoffMs(attempts: number): number;
    /** Submits only never-sent work; an uncertain attempted POST is observed, never replayed. */
    submitPending(companionId: string, now?: number, limit?: number): Promise<SubmitCounts>;
    /** Polls due operations serially; an empty queue performs no backend call. */
    pollDue(now?: number, limit?: number): Promise<PollCounts>;
    /** Requests cleanup. Cooperative writes finish naturally so their completion remains provable. */
    cancel(companionId: string, operationId: string, now?: number): BackendOperation;
    /** Proves each write settled, then erases payload and finally its revoked document. */
    cleanupDue(now?: number, limit?: number): Promise<CleanupCounts>;
    /** One background pass: poll due operations, then finish due cleanups. Submission is explicit. */
    runOnce(now?: number): Promise<RunCounts>;
    /** Submit, poll and clean up a single companion in one serial pass. */
    process(companionId: string, now?: number): Promise<{
        submit: SubmitCounts;
        poll: PollCounts;
        cleanup: CleanupCounts;
    }>;
    private shouldEraseDocument;
}
