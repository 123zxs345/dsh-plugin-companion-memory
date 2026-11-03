import type { BackendOperation, CandidateDecision, CleanupState, CompanionSeed, EventMetadata, EvidenceRef, ForgetMode, ForgetReceipt, ForgetRequest, MemoryJob, OperationState, ProfileCandidate, ProfileCandidateInput, ProfileChange, ProfileDomain, ProfileEntry, ProfileFact, SourceEvent, ToolReceipt } from '../contracts.ts';
import { type MigrationWarning } from './migrations/index.ts';
import { CompanionMemoryStore } from '../memory/companion-store.ts';
import type { StageEventOptions } from '../memory/companion-types.ts';
export declare const STATE_SCHEMA_VERSION = 9;
export declare const SUBMIT_CLAIM_PREFIX = "submit-claim:";
export declare const SUBMIT_CLAIM_MS = 120000;
export interface StateStoreOptions {
    /**
     * Which storage backs listProfile. Since the migration dual-read comparison passes,
     * the default is the fact-version store; 'materialized' keeps the legacy view available
     * as a fallback without dropping the old table.
     */
    profileReadSource?: 'materialized' | 'facts';
    /** Called for every non-fatal migration warning (for example a snapshot that could not be deleted). */
    onMigrationWarning?: (warning: MigrationWarning) => void;
}
export interface DocumentStatus {
    source: 'active' | 'suppressed' | 'superseded' | 'forgotten' | 'missing';
    remote: 'pending' | 'running' | 'failed' | 'uncertain' | 'retained' | 'deleted' | 'not_applicable';
}
export interface ForgetOutcome {
    requestId: string;
    epoch: number;
    mode: ForgetMode;
    forgotten: string[];
}
export interface ProfileReadComparison {
    consistent: boolean;
    materialized: ProfileEntry[];
    facts: ProfileEntry[];
    differences: string[];
}
export interface PrepareOperationInput {
    documentId: string;
    sourceRevision: number;
    payloadHash: string;
    operationId?: string;
    /** External discovery is not evidence that this application sent exactly one POST. */
    provenance?: 'external-unknown';
}
export interface OperationPatch {
    state?: OperationState;
    attempts?: number;
    nextCheckAt?: number;
    lastCheckedAt?: number | null;
    submittedAt?: number | null;
    completedAt?: number | null;
    errorCode?: string | null;
    cleanupState?: CleanupState;
    /** Null clears the stored payload hash once the remote payload is provably erased. */
    payloadHash?: string | null;
}
export interface ForgetPatch {
    local?: CleanupState;
    backend?: CleanupState;
    operationPayloads?: CleanupState;
    hostHistory?: CleanupState;
    backups?: 'not-included' | CleanupState;
}
/**
 * Normalize a companion seed's persona anchors exactly the way they are stored:
 * profile keys are validated and values are trimmed to at most 4000 characters.
 * Entry budget validation and ensureCompanion must agree on this shape, otherwise
 * an anchor padded with whitespace is measured against a snapshot the store never
 * writes and a valid budget gets rejected.
 */
export declare function normalizeAnchors(anchors: unknown): Record<string, string>;
export declare class StateStore {
    private readonly db;
    readonly companionMemory: CompanionMemoryStore;
    private readonly profileReadSource;
    private readonly migrationWarnings;
    constructor(path: string, options?: StateStoreOptions);
    ensureCompanion(seed: CompanionSeed): void;
    ingest(event: SourceEvent): boolean;
    /** Persist an admitted complete source for API review; duplicates and ineligible sources return false. */
    stageEvent(event: SourceEvent, options?: StageEventOptions): boolean;
    private appendEvent;
    getEvent(companionId: string, eventId: string): SourceEvent | null;
    listEvents(companionId: string, sessionId: string, limit?: number): SourceEvent[];
    eventMetadata(companionId: string, eventId: string): EventMetadata | null;
    registerToolReceipt(receipt: ToolReceipt): ToolReceipt;
    toolReceipt(id: string): ToolReceipt | null;
    isProfileSource(companionId: string, eventId: string): boolean;
    applyProfileChange(companionId: string, change: ProfileChange): ProfileEntry;
    listProfile(companionId: string, domain?: ProfileDomain): ProfileEntry[];
    listProfileMaterialized(companionId: string, domain?: ProfileDomain): ProfileEntry[];
    listProfileFromFacts(companionId: string, domain?: ProfileDomain): ProfileEntry[];
    compareProfileReads(companionId: string): ProfileReadComparison;
    commitCandidate(companionId: string, input: ProfileCandidateInput): CandidateDecision;
    addEvidence(companionId: string, factId: string, evidence: EvidenceRef): ProfileFact;
    removeEvidence(companionId: string, factId: string, eventId: string, sourceRevision: number): ProfileFact | null;
    listFacts(companionId: string, domain?: ProfileDomain): ProfileFact[];
    listCandidates(companionId: string): ProfileCandidate[];
    /**
     * Persists a proposed candidate without touching profile facts. Proposals carry
     * an expiry so a later field-review task can expire or commit them.
     */
    proposeCandidate(companionId: string, input: ProfileCandidateInput): ProfileCandidate;
    /** Uncommitted, unexpired proposals for field review. */
    listProposals(companionId: string): ProfileCandidate[];
    currentEpoch(companionId: string): number;
    bumpEpoch(companionId: string): number;
    forgetEvents(companionId: string, eventIds: string[], mode: ForgetMode): ForgetOutcome;
    forgetEvent(companionId: string, eventId: string): void;
    forgetRequest(requestId: string): ForgetRequest | null;
    updateForgetRequest(requestId: string, patch: ForgetPatch): ForgetRequest;
    /** Forget requests whose backend or operation-payload cleanup still has unreported work. */
    forgetRequestsToAdvance(limit?: number): ForgetRequest[];
    forgetReceipt(requestId: string): ForgetReceipt;
    /** Cancels a queued legacy retain job, e.g. when the async operation path owns the write. */
    cancelPendingRetain(companionId: string, documentId: string): void;
    /** Every companion with durable state, for batch maintenance. */
    listCompanions(): string[];
    prepareOperation(companionId: string, input: PrepareOperationInput): BackendOperation;
    /** Location registration, eligibility/hash read, operation creation and binding share one write lock. */
    prepareMaterialOperation(companionId: string, ref: {
        memoryId: string;
        revision: number;
    }, bank: string, documentId: string, identity: (companionId: string, handle: string, revision: number, hash: string) => string): BackendOperation | null;
    memoryFence(companionId: string): {
        stateEpoch: number;
        deletionWatermark: number;
    };
    materialOperationSnapshot(companionId: string, operationId: string): {
        memory: import("../memory/companion-types.ts").CompanionMemory;
        content: string;
        payloadHash: string;
        location: import("../memory/companion-types.ts").MemoryIndexLocation;
        operation: BackendOperation;
    } | null;
    verifyLegacyRollback(companionId: string): {
        stateEpoch: number;
        deletionWatermark: number;
    };
    getOperation(companionId: string, operationId: string): BackendOperation | null;
    pendingOperations(companionId: string, limit?: number): BackendOperation[];
    /** Only locally proven never-sent work. Operation IDs are not permanent remote replay tombstones. */
    operationsAwaitingSubmit(companionId: string, limit?: number, materialsOnly?: boolean): BackendOperation[];
    /** A claim is never replaced merely because its scheduler deadline expired. */
    claimOperationSubmission(companionId: string, operationId: string, now: number, materialAllowed?: (operation: BackendOperation) => boolean): {
        operation: BackendOperation;
        token: string;
        previousAttempts: number;
    } | null;
    /** A stale worker cannot replace a newer lease or undo cancellation/forget. */
    settleOperationSubmission(companionId: string, operationId: string, token: string, patch: OperationPatch, writeNotAttempted?: boolean): BackendOperation | null;
    /** A remote completion cannot settle or release a still-live local POST claim. */
    recordOperationCompletion(companionId: string, operationId: string, now: number, patch?: OperationPatch): BackendOperation;
    /** Persist payload acknowledgement before final document I/O, without claiming it was deleted. */
    confirmOperationPayloadErased(companionId: string, operationId: string, now: number): BackendOperation | null;
    /** Quarantine old evidence even when a restored snapshot claims it was already erased. */
    operationProofsForCleanup(companionId: string, operationId: string): BackendOperation | null;
    /** Choose token preservation and attempts from the same locked row that is updated. */
    markOperationCleanup(companionId: string, operationId: string, now: number, requestedState: 'unknown' | 'blocked', errorCode: string, backoffMs: (attempts: number) => number): BackendOperation | null;
    /** Operations that asked for cancellation or whose payload must be erased after a late/ambiguous outcome. */
    operationsToCleanup(now: number, limit?: number): BackendOperation[];
    operationsToPoll(now: number, limit?: number): BackendOperation[];
    operationsForDocument(companionId: string, documentId: string): BackendOperation[];
    /** Re-enumerate history every pass. An externally known operation has no local never-attempted proof. */
    operationsForForget(companionId: string, eventIds: readonly string[]): BackendOperation[];
    acknowledgeForgetDocumentDeletion(companionId: string, eventId: string): void;
    legacyWritesUnsettled(companionId: string, eventIds: readonly string[]): boolean;
    /** Documents whose queued retain job has not been converted into a durable async operation yet. */
    pendingRetainDocuments(companionId: string, limit?: number): string[];
    updateOperation(companionId: string, operationId: string, patch: OperationPatch): BackendOperation;
    listDerivedDependencies(derivedId: string): {
        sourceId: string;
        sourceRevision: number;
    }[];
    isDocumentAllowed(companionId: string, documentId: string): boolean;
    documentStatus(companionId: string, documentId: string): DocumentStatus;
    claimJob(now: number, leaseMs: number, companionId?: string): MemoryJob | null;
    completeJob(jobId: number, leaseToken: string): boolean;
    failJob(jobId: number, leaseToken: string, now: number, uncertainWrite?: boolean): boolean;
    /** Non-fatal warnings produced while opening/migrating this database (e.g. a leftover snapshot). */
    schemaWarnings(): MigrationWarning[];
    stats(): {
        pending: number;
        running: number;
        failed: number;
        uncertainWrites: number;
    };
    retryFailed(): number;
    close(): void;
    private requireSupportedSchema;
    private requireCompanion;
    private eventRow;
    private metadataRow;
    private factRow;
    private activeFactRow;
    private evidenceRows;
    private asFact;
    private asCandidate;
    private maxFactRevision;
    private maxProfileRevision;
    private profileSupportRejection;
    private normalizeCandidate;
    private validateEvidenceTx;
    private insertCandidateTx;
    private commitLocked;
    private insertEvidenceTx;
    private addEvidenceToFactTx;
    private retractFactTx;
    private writeMaterialized;
    private supersedeEvidenceEvents;
    /**
     * Rebuilds the current value from the most recent past version that still has
     * valid evidence. Corrected values never return: they were explicitly wrong.
     * A past version whose quotes were superseded by a real replacement has no
     * independent support left, so it cannot become current again.
     */
    private restoreFallbackTx;
    private evidenceStillAllowed;
    private currentEpochTx;
    private bumpEpochTx;
    private eraseEventsTx;
    private reevaluateEvidenceTx;
    private enqueue;
    private cancelRetain;
    private hasUncertainWrite;
    private settleJob;
}
