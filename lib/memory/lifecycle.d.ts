import type { AsyncOperationBackend, ForgetReceipt } from '../contracts.ts';
import { StateStore } from '../state/store.ts';
export declare const MAX_FORGET_BATCH = 100;
/**
 * Advances forget-request cleanup by location. Local redaction is already done
 * inside the forget transaction; this drives backend document deletion and
 * operation-payload erasure, and reports host history as blocked because this
 * build has no host-history adapter. Backups are never included. A failed or
 * partial cleanup stays unknown/blocked instead of being reported as erased.
 */
export declare class ForgetLifecycle {
    private readonly store;
    private readonly backend;
    private readonly clock;
    constructor(store: StateStore, backend: AsyncOperationBackend, clock?: () => number);
    advance(requestId: string): Promise<ForgetReceipt>;
    /** Advances all forget requests that still report backend or payload work. */
    runBatch(limit?: number): Promise<ForgetReceipt[]>;
    private deleteDocuments;
    private eraseOperationPayloads;
}
