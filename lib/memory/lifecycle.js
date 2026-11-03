import { bankId } from './hindsight.js';
import { cleanupOperationPayload, deleteLocatedDocument, isDefiniteBackendRejection, OP_POLL_BACKOFF_MS, writeSettled } from './operations.js';
export const MAX_FORGET_BATCH = 100;
function statusOf(error) {
    return isDefiniteBackendRejection(error) ? 'blocked' : 'unknown';
}
/**
 * Advances forget-request cleanup by location. Local redaction is already done
 * inside the forget transaction; this drives backend document deletion and
 * operation-payload erasure, and reports host history as blocked because this
 * build has no host-history adapter. Backups are never included. A failed or
 * partial cleanup stays unknown/blocked instead of being reported as erased.
 */
export class ForgetLifecycle {
    store;
    backend;
    clock;
    constructor(store, backend, clock = Date.now) {
        this.store = store;
        this.backend = backend;
        this.clock = clock;
    }
    async advance(requestId) {
        const initial = this.store.forgetRequest(requestId);
        if (initial === null)
            throw new Error('Unknown forget request');
        const now = this.clock();
        if (initial.operationPayloads === 'pending' || initial.operationPayloads === 'unknown') {
            const operationPayloads = await this.eraseOperationPayloads(initial.companionId, initial.eventIds, now);
            this.store.updateForgetRequest(requestId, { operationPayloads });
        }
        const current = this.store.forgetRequest(requestId);
        if (current.backend === 'pending' || current.backend === 'unknown') {
            // DELETE before an unresolved POST is only a temporary absence. Do the final
            // document deletion after every relevant write is settled or payload-erased.
            const settled = !this.store.legacyWritesUnsettled(initial.companionId, initial.eventIds) && this.store.operationsForForget(initial.companionId, initial.eventIds)
                .every(operation => operation.state === 'erased' || writeSettled(operation, false));
            const backend = settled ? await this.deleteDocuments(initial.companionId, initial.eventIds) : 'unknown';
            this.store.updateForgetRequest(requestId, { backend });
        }
        return this.store.forgetReceipt(requestId);
    }
    /** Advances all forget requests that still report backend or payload work. */
    async runBatch(limit = MAX_FORGET_BATCH) {
        const receipts = [];
        const requests = this.store.forgetRequestsToAdvance(limit);
        for (const request of requests)
            receipts.push(await this.advance(request.id));
        return receipts;
    }
    async deleteDocuments(companionId, eventIds) {
        const deleted = new Set();
        for (const eventId of new Set(eventIds)) {
            try {
                await this.backend.deleteDocument(companionId, eventId);
                this.store.acknowledgeForgetDocumentDeletion(companionId, eventId);
                deleted.add(JSON.stringify([bankId(companionId), eventId]));
            }
            catch (error) {
                return statusOf(error);
            }
        }
        for (const location of this.store.companionMemory.indexLocationsForEvents(companionId, eventIds)) {
            if (location.cleanupState === 'done')
                continue;
            // Registration can happen during the preceding HTTP DELETE. Discover its
            // payload/write evidence before deleting this newly visible position.
            const associated = this.store.operationsForForget(companionId, eventIds).filter(o => o.operationId === location.operationId);
            if (associated.some(o => o.state !== 'erased'))
                return 'unknown';
            try {
                const key = JSON.stringify([location.bank, location.documentId]);
                if (!deleted.has(key))
                    await deleteLocatedDocument(this.backend, location);
                deleted.add(key);
                const updated = this.store.companionMemory.updateIndexLocation(companionId, location.id, { indexState: 'erased', cleanupState: 'done' });
                if (updated.cleanupState !== 'done')
                    return 'unknown';
            }
            catch (error) {
                const state = statusOf(error);
                this.store.companionMemory.updateIndexLocation(companionId, location.id, { cleanupState: state });
                return state;
            }
        }
        return 'done';
    }
    async eraseOperationPayloads(companionId, eventIds, now) {
        let result = 'done';
        for (const operation of this.store.operationsForForget(companionId, eventIds)) {
            const cleaned = await cleanupOperationPayload(this.store, this.backend, operation, now, attempts => {
                const index = Math.min(Math.max(attempts, 0), OP_POLL_BACKOFF_MS.length - 1);
                return OP_POLL_BACKOFF_MS[index] ?? 30_000;
            });
            if (cleaned === 'blocked')
                result = 'blocked';
            else if (cleaned === 'unknown' && result !== 'blocked')
                result = 'unknown';
        }
        return result;
    }
}
