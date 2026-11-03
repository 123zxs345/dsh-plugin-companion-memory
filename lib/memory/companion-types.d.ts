import type { EventMetadata, SourceEvent } from '../contracts.ts';
/** Storage protocol only: semantic judgments belong to the main API. */
export type CompanionMemoryView = 'user_understanding' | 'shared_episode' | 'interaction_habit';
export type CompanionMemoryAction = 'retain' | 'merge' | 'condense' | 'deprioritize' | 'discard' | 'defer';
export type CompanionMemoryStatus = 'active' | 'historical' | 'condensed' | 'deprioritized' | 'discarded' | 'forgotten';
export type StagedSourcePurpose = 'companion' | 'task';
export type CompanionTaskState = 'active' | 'completed';
export type StagedSourceStatus = 'pending' | 'reviewed' | 'ignored' | 'compacted' | 'erased';
/** Assistant text is always interaction evidence, never an owner statement. */
export type CompanionEvidenceKind = 'user_statement' | 'interaction' | 'tool_result';
export interface CompanionMemoryRevisionRef {
    memoryId: string;
    revision: number;
}
export interface CompanionSourceRef {
    eventId: string;
    sourceRevision: number;
}
export interface CompanionMemory extends CompanionMemoryRevisionRef {
    companionId: string;
    /** Model-authored retrieval summary. Legacy records remain null until explicitly summarized. */
    summary?: string | null;
    meaning: string;
    anchors: string[];
    view: CompanionMemoryView;
    certainty: 'explicit' | 'inferred';
    reason: string;
    useWhen: string;
    avoidWhen: string;
    status: CompanionMemoryStatus;
    pinned: boolean;
    detailsUnavailable: boolean;
    /** Trusted lifecycle metadata; never accepted in a model draft. */
    detailState: 'required' | 'cold' | 'unavailable';
    detailColdSince: string | null;
    createdAt: string;
    lastReviewedAt: string | null;
    lastRetrievedAt: string | null;
    /** Last inclusion in an actual main-model request; this does not claim it helped the answer. */
    lastPresentedAt: string | null;
}
/** Model-authored content only. IDs, pins and lifecycle state belong to the service. */
export interface CompanionMemoryDraft {
    summary?: string;
    meaning: string;
    anchors: string[];
    view: CompanionMemoryView;
    certainty: 'explicit' | 'inferred';
    reason: string;
    useWhen: string;
    avoidWhen: string;
    sourceRefs: CompanionSourceRef[];
    parentRefs: CompanionMemoryRevisionRef[];
}
export type CompanionMemoryOperation = {
    action: 'retain';
    draft: CompanionMemoryDraft;
} | {
    action: 'merge';
    targets: CompanionMemoryRevisionRef[];
    draft: CompanionMemoryDraft;
} | {
    action: 'condense';
    target: CompanionMemoryRevisionRef;
    draft: CompanionMemoryDraft;
} | {
    action: 'deprioritize';
    target: CompanionMemoryRevisionRef;
} | {
    action: 'discard';
    target: CompanionMemoryRevisionRef;
}
/** Fill a missing retrieval summary without changing refined content or revision. */
 | {
    action: 'summarize';
    target: CompanionMemoryRevisionRef;
    summary: string;
}
/** Explicit model decision to release original detail while keeping selected summaries and anchors. */
 | {
    action: 'release_details';
    sourceRefs: CompanionSourceRef[];
    summaries?: CompanionMemoryRevisionRef[];
} | {
    action: 'defer';
    sourceRefs: CompanionSourceRef[];
};
export interface CompanionMemoryPlan {
    planId: string;
    companionId: string;
    expectedEpoch: number;
    reviewedSources: CompanionSourceRef[];
    /** May be empty when reviewedSources is nonempty; reviewing can yield no semantic changes. */
    operations: CompanionMemoryOperation[];
}
export interface CompanionMemoryPlanResult {
    status: 'applied';
    planId: string;
    stateEpoch: number;
    /** Created revisions in operation order; state-only actions do not create revisions. */
    memories: CompanionMemoryRevisionRef[];
}
export interface ListCompanionMemoriesOptions {
    includeHistory?: boolean;
    limit?: number;
}
export type RegisterMemoryIndexLocation = {
    bank: string;
    bankKind: MemoryIndexLocation['bankKind'];
    documentId: string;
    operationId?: string | null;
} & ({
    source: CompanionSourceRef;
    memory?: never;
} | {
    memory: CompanionMemoryRevisionRef;
    source?: never;
});
export interface DetailCleanupCheck {
    source: CompanionSourceRef;
    eligible: boolean;
    blockers: ('source-unavailable' | 'pending-review' | 'active-task' | 'pinned-memory' | 'memory-needs-details' | 'profile-evidence' | 'profile-candidate')[];
}
export interface CompanionMemoryEvidence extends CompanionMemoryRevisionRef, CompanionSourceRef {
    companionId: string;
    sourceRole: SourceEvent['role'];
}
export interface CompanionMemoryLink {
    companionId: string;
    parent: CompanionMemoryRevisionRef;
    child: CompanionMemoryRevisionRef;
}
export interface MemoryIndexLocation {
    companionId: string;
    id: string;
    bank: string;
    bankKind: 'legacy' | 'companion';
    documentId: string;
    operationId: string | null;
    source: CompanionSourceRef | null;
    memory: CompanionMemoryRevisionRef | null;
    indexState: 'pending' | 'indexed' | 'failed' | 'erased';
    cleanupState: 'not-requested' | 'pending' | 'done' | 'blocked' | 'unknown';
}
/** taskId must come from trusted task orchestration, never extracted from source text. */
export interface StageEventOptions {
    purpose: StagedSourcePurpose;
    taskId?: string;
}
export interface ListPendingSourcesOptions {
    /** Defaults to 100; accepts 1..1000. Text is never truncated. */
    limit?: number;
    sessionId?: string;
}
export interface PendingCompanionSource {
    event: SourceEvent;
    metadata: EventMetadata;
    purpose: StagedSourcePurpose;
    taskId: string | null;
    taskState: CompanionTaskState | null;
    status: 'pending';
    evidenceKind: CompanionEvidenceKind;
    stagedAt: string;
    /** Explicit source invalidation only. No age-based pending TTL is assigned. */
    expiresAt: string | null;
}
