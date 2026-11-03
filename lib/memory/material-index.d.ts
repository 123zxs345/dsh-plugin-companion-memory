import type { BackendOperation, ForgetReceipt } from '../contracts.ts';
import { StateStore } from '../state/store.ts';
import type { CompanionMemory } from './companion-types.ts';
import { HindsightBackend } from './hindsight.ts';
import { ForgetLifecycle } from './lifecycle.ts';
import { type MemoryRetrievalOptions } from './retrieval-policy.ts';
import { OperationCoordinator, type CleanupCounts, type MaterialDocumentPort, type PollCounts, type SubmitCounts } from './operations.ts';
export declare function materialBankId(companionId: string): string;
export interface MaterialRecallHit {
    similarity: number;
    memory: CompanionMemory;
    text: string;
    locationId: string;
    bank: string;
    documentId: string;
}
export interface MaterialMaintenanceResult {
    submit: SubmitCounts;
    poll: PollCounts;
    cleanup: CleanupCounts;
    forget: ForgetReceipt[];
}
/** Independent approved-material index. Runtime context budgeting and generation are separate callers. */
export declare class MemoryMaterialIndex {
    readonly documentPort: MaterialDocumentPort;
    readonly coordinator: OperationCoordinator;
    readonly lifecycle: ForgetLifecycle;
    private readonly store;
    private readonly backend;
    private readonly clock;
    constructor(store: StateStore, backend: HindsightBackend, options?: {
        clock?: () => number;
    });
    private read;
    ensurePending(companionId: string): BackendOperation[];
    maintain(companionId: string): Promise<MaterialMaintenanceResult>;
    recall(companionId: string, query: string, tokenBudget: number, options?: MemoryRetrievalOptions): Promise<MaterialRecallHit[]>;
    /** Call immediately before enabling a legacy reader, and compare this fence after its HTTP response. */
    verifyLegacyRollback(companionId: string): {
        stateEpoch: number;
        deletionWatermark: number;
    };
}
