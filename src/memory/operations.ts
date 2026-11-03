import { createHash } from 'node:crypto';
import type {
  AsyncOperationBackend,
  BackendOperation,
  BackendOperationStatus,
  CleanupState,
  SourceEvent,
} from '../contracts.ts';
import { StateStore, SUBMIT_CLAIM_PREFIX } from '../state/store.ts';
import type { MemoryIndexLocation } from './companion-types.ts';

export interface MaterialDocument {
  companionId: string; handle: string; bank: string; documentId: string; revision: number; content: string; payloadHash: string;
}
/** Local pre-POST refusal, never inferred from a remote HTTP response. */
export class MaterialWriteNotAttemptedError extends Error {
  readonly status?: number;
  constructor(cause: unknown) { super('Material write not attempted'); this.status=backendHttpStatus(cause); }
}
/** Material eligibility is called again under the existing durable claim transaction. */
export interface MaterialDocumentPort {
  read(operation: BackendOperation): MaterialDocument | null;
  allowed(operation: BackendOperation): boolean;
  shouldErase(companionId: string, handle: string): boolean;
  submit(document: MaterialDocument, operationId: string): Promise<{operationId:string;state:'submitted'|'processing'}>;
  deleteDocument(companionId: string, handle: string): Promise<void>;
}
export type LocatedDeleteBackend = AsyncOperationBackend & {deleteLocatedDocument?: (location: MemoryIndexLocation) => Promise<void>};

/** A location handle is never guessed to be an event ID when a backend lacks this capability. */
export async function deleteLocatedDocument(backend: LocatedDeleteBackend, location: MemoryIndexLocation): Promise<void> {
  if (backend.deleteLocatedDocument === undefined) throw Object.assign(new Error('Backend cannot delete known index location'),{status:422});
  await backend.deleteLocatedDocument(location);
}

export const MAX_POLL_BATCH = 100;
/** 2s, 5s, 10s, 30s, then stay at 30s. */
export const OP_POLL_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];
const BLOCKED_UNTIL = Number.MAX_SAFE_INTEGER;

function digest(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Deterministic UUID-shaped operation identity; the server accepts caller-supplied UUIDs for idempotent async retries. */
function uuidFromHash(hex: string): string {
  return [hex.slice(0, 8), hex.slice(8, 12), '4' + hex.slice(13, 16), 'a' + hex.slice(17, 20), hex.slice(20, 32)].join('-');
}

/** Hash of everything that would change what the backend stores for one source revision. */
export function retainPayloadHash(event: SourceEvent): string {
  return digest([event.id, event.companionId, event.role, event.visibility, event.toolVerified === true ? 'verified' : 'plain', event.content, event.occurredAt]);
}

/** Same companion, document, source revision and payload always map to the same durable operation ID. */
export function operationIdFor(companionId: string, documentId: string, sourceRevision: number, payloadHash: string): string {
  return uuidFromHash(digest([companionId, documentId, String(sourceRevision), payloadHash]));
}

/** HTTP status carried by an adapter error, if any. Unknown objects and timeouts have none. */
export function backendHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined;
}

/** Only a definite 4xx (not 408/429) proves the backend rejected the request; everything else stays uncertain. */
export function isDefiniteBackendRejection(error: unknown): boolean {
  const status = backendHttpStatus(error);
  if (status === undefined || status < 400 || status >= 500) return false;
  return status !== 408 && status !== 429;
}

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
export function writeSettled(operation: BackendOperation, quiescentCancellation: boolean): boolean {
  if(operation.submissionProtocolVersion!==1)return false;
  // A cancel response cannot settle a POST which has not reached the server yet.
  if (submissionInFlight(operation)) return false;
  return operation.completedAt !== null || (operation.submittedAt === null && operation.attempts === 0)
    || (quiescentCancellation && operation.submittedAt !== null);
}

export function submissionInFlight(operation: BackendOperation): boolean {
  return operation.errorCode?.startsWith(SUBMIT_CLAIM_PREFIX) === true;
}

/** Cleanup retries must not manufacture evidence that a POST was attempted. */
export function nextCleanupAttempts(operation: BackendOperation): number {
  return operation.submittedAt === null && operation.attempts === 0 ? 0 : operation.attempts + 1;
}

export interface SubmitCounts { submitted: number; failed: number; unknown: number; erased: number }
export interface PollCounts { polled: number; completed: number; failed: number; unknown: number; cleanupRequested: number }
export interface CleanupCounts { cleaned: number; erased: number; unknown: number; blocked: number }
export interface RunCounts { poll: PollCounts; cleanup: CleanupCounts }

class OperationIdentityError extends Error {
  constructor() { super('Operation identity mismatch'); this.name = 'OperationIdentityError'; }
}

function emptySubmit(): SubmitCounts { return { submitted: 0, failed: 0, unknown: 0, erased: 0 }; }
function emptyPoll(): PollCounts { return { polled: 0, completed: 0, failed: 0, unknown: 0, cleanupRequested: 0 }; }
function emptyCleanup(): CleanupCounts { return { cleaned: 0, erased: 0, unknown: 0, blocked: 0 }; }

function errorCodeFor(prefix: string, error: unknown): string {
  const status = backendHttpStatus(error);
  return status === undefined ? prefix + '-uncertain' : prefix + '-' + String(status);
}

export type OperationCleanupResult = 'erased' | 'already-erased' | 'unknown' | 'blocked';

/** One cleanup proof for both schedulers. Keep upstream evidence until the write is actually settled. */
export async function cleanupOperationPayload(store: StateStore, backend: AsyncOperationBackend, initial: BackendOperation,
  now: number, backoffMs: (attempts: number) => number, beforeErased?: (operation: BackendOperation) => Promise<void>): Promise<OperationCleanupResult> {
  let operation = store.operationProofsForCleanup(initial.companionId,initial.operationId) ?? initial;
  if(operation.submissionProtocolVersion!==1)return 'blocked';
  if (operation.state === 'erased' && operation.payloadErasureVersion===1) return 'already-erased';
  const mark = (state: 'unknown' | 'blocked', code: string): OperationCleanupResult => {
    const updated=store.markOperationCleanup(operation.companionId,operation.operationId,now,state,code,backoffMs);
    if(updated===null)return 'unknown';
    if(updated.state==='erased')return 'already-erased';
    return updated.cleanupState==='blocked' ? 'blocked' : 'unknown';
  };
  const finish = async (): Promise<OperationCleanupResult> => {
    if (beforeErased !== undefined) {
      try { await beforeErased(operation); }
      catch (error) { return mark('unknown',errorCodeFor('document-cleanup',error)); }
    }
    const updated=store.updateOperation(operation.companionId,operation.operationId,{state:'erased',cleanupState:'done',completedAt:now,
      lastCheckedAt:now,nextCheckAt:now,errorCode:null,payloadHash:null});
    return updated.state==='erased' ? 'erased' : 'unknown';
  };
  // A prior invocation confirmed the complete family disappeared. Its parent
  // can now be missing; retry only the final document action after restart.
  if(operation.cleanupState==='done' && operation.payloadErasureVersion===1)return submissionInFlight(operation) ? mark('unknown','payload-proof-has-active-claim') : finish();
  const observe = async (): Promise<BackendOperationStatus | {error:unknown}> => {
    try {
      const hadClaim = submissionInFlight(operation);
      const status = await backend.operationStatus(operation.companionId,operation.operationId);
      if (status.state === 'completed' && !hadClaim) operation = store.recordOperationCompletion(operation.companionId,operation.operationId,now);
      return status.state;
    } catch (error) { return {error}; }
  };
  const quiescentBackend = backend.cancellationGuarantee === 'quiescent';
  // Do not actively cancel cooperative writes: cancelled hides their later
  // natural completion and the public API provides no worker join/drain proof.
  if (!writeSettled(operation,false) && (!quiescentBackend || submissionInFlight(operation))) {
    const observed = await observe();
    if (!writeSettled(operation,false)) {
      if (typeof observed === 'object') return mark(isDefiniteBackendRejection(observed.error) ? 'blocked' : 'unknown',errorCodeFor('quiescence-status',observed.error));
      return mark(observed === 'cancelled' || observed === 'failed' ? 'blocked' : 'unknown','write-quiescence-unproven-' + observed);
    }
  }
  let quiescentCancellation = false;
  let cancelRejected = false;
  let blockedCode = 'cleanup-blocked';
  if (quiescentBackend) {
    try { quiescentCancellation = await backend.cancelOperation(operation.companionId,operation.operationId) === true; }
    catch (error) {
      if (!isDefiniteBackendRejection(error)) return mark('unknown',errorCodeFor('cancel',error));
      cancelRejected = true; blockedCode = errorCodeFor('cancel',error);
    }
    if (!writeSettled(operation,quiescentCancellation)) await observe();
    if (!writeSettled(operation,quiescentCancellation)) {
      if (quiescentCancellation && operation.submittedAt === null) return mark('unknown','unacknowledged-submit');
      return mark('blocked',cancelRejected ? blockedCode : 'write-quiescence-unproven');
    }
  }
  // This guard is intentionally independent of payload deletion. A terminal
  // cancelled/failed row or payload 404 never upgrades a write into settled.
  if (!writeSettled(operation,quiescentCancellation)) return mark('unknown','write-quiescence-unproven');
  let deleted: boolean;
  const neverAttempted=operation.submittedAt===null && operation.attempts===0 && !submissionInFlight(operation);
  try { deleted = await backend.deleteOperationPayload(operation.companionId,operation.operationId,neverAttempted ? {neverAttempted:true} : undefined) === true; }
  catch (error) { return mark(isDefiniteBackendRejection(error) ? 'blocked' : 'unknown',errorCodeFor('cleanup',error)); }
  if (!deleted) return mark('unknown','cleanup-unconfirmed');
  const confirmed=store.confirmOperationPayloadErased(operation.companionId,operation.operationId,now);
  if(confirmed===null)return mark('unknown','payload-proof-has-active-claim');
  if(confirmed.state==='erased')return 'already-erased';
  operation=confirmed;
  return finish();
}

/**
 * Drives the durable async-operation state machine over StateStore rows:
 * pending -> submitted -> processing -> completed, with failed only for a
 * definite backend rejection and unknown for timeouts or ambiguous answers.
 * Submission, polling and cleanup are one-at-a-time (serial), batch-capped at
 * MAX_POLL_BATCH, and never call the backend for an empty queue.
 */
export class OperationCoordinator {
  private readonly store: StateStore;
  private readonly backend: AsyncOperationBackend;
  private readonly clock: () => number;
  private readonly materials?: MaterialDocumentPort;

  constructor(store: StateStore, backend: AsyncOperationBackend, clock: () => number = Date.now, materials?: MaterialDocumentPort) {
    this.store = store;
    this.backend = backend;
    this.clock = clock;
    this.materials = materials;
  }

  backoffMs(attempts: number): number {
    const index = Math.min(Math.max(attempts, 0), OP_POLL_BACKOFF_MS.length - 1);
    return OP_POLL_BACKOFF_MS[index] ?? 30_000;
  }

  /** Submits only never-sent work; an uncertain attempted POST is observed, never replayed. */
  async submitPending(companionId: string, now: number = this.clock(), limit: number = MAX_POLL_BATCH): Promise<SubmitCounts> {
    const counts = emptySubmit();
    const operations = this.store.operationsAwaitingSubmit(companionId, limit, this.materials !== undefined);
    let firstClaimClock: number | undefined;
    for (const operation of operations) {
      const at = firstClaimClock === undefined ? now : now + Math.max(0, this.clock() - firstClaimClock);
      if (operation.state === 'unknown' && operation.nextCheckAt > at) continue;
      const material = this.materials?.read(operation);
      const event = this.materials === undefined ? this.store.getEvent(companionId, operation.documentId) : null;
      const boundLocation=this.store.companionMemory.indexLocationForOperation(companionId,operation.operationId);
      if (this.materials === undefined ? event === null || boundLocation?.memory != null && boundLocation.id===operation.documentId || !this.store.isDocumentAllowed(companionId, operation.documentId) : material == null) {
        // A stale queue snapshot may outlive a forget. Payload deletion still needs
        // its own acknowledgement, including for a submission never attempted.
        this.store.updateOperation(companionId, operation.operationId, {state:'cleanup_pending', cleanupState:'pending', nextCheckAt:at});
        continue;
      }
      // `now` may be an explicitly controlled scheduler time. Preserve that
      // origin while adding real/fake clock time elapsed in this serial batch.
      const claimClock = this.clock();
      firstClaimClock ??= claimClock;
      const claimAt = now + Math.max(0, claimClock - firstClaimClock);
      const claim = this.store.claimOperationSubmission(companionId, operation.operationId, claimAt, this.materials === undefined ? undefined : current => this.materials!.allowed(current));
      if (claim === null) continue;
      try {
        const receipt = this.materials !== undefined && material != null ? await this.materials.submit(material,operation.operationId) : await this.backend.submitRetain(event!, operation.operationId);
        if (receipt === null || typeof receipt !== 'object' || receipt.operationId !== operation.operationId) throw new OperationIdentityError();
        const settled = this.store.settleOperationSubmission(companionId, operation.operationId, claim.token, {
          state: receipt.state === 'processing' ? 'processing' : 'submitted',
          attempts: claim.previousAttempts,
          submittedAt: operation.submittedAt ?? claimAt,
          lastCheckedAt: claimAt,
          nextCheckAt: claimAt + this.backoffMs(0),
          errorCode: null,
        });
        if (settled !== null) {
          if (this.materials !== undefined && this.materials.shouldErase(companionId,operation.documentId)) this.store.updateOperation(companionId,operation.operationId,{state:'cleanup_pending',cleanupState:'pending',nextCheckAt:0});
          counts.submitted += 1;
        }
      } catch (error) {
        if(error instanceof MaterialWriteNotAttemptedError) {
          const definite=isDefiniteBackendRejection(error);
          const settled=this.store.settleOperationSubmission(companionId,operation.operationId,claim.token,{state:definite?'failed':'unknown',attempts:claim.previousAttempts,lastCheckedAt:claimAt,nextCheckAt:claimAt+this.backoffMs(operation.attempts),errorCode:errorCodeFor('material-preflight',error)},true);
          if(settled?.state==='failed')counts.failed++;else if(settled!==null)counts.unknown++;
          continue;
        }
        if (error instanceof OperationIdentityError) {
          const settled = this.store.settleOperationSubmission(companionId, operation.operationId, claim.token, { state: 'unknown', attempts: claim.operation.attempts, lastCheckedAt: claimAt, nextCheckAt: claimAt + this.backoffMs(operation.attempts), errorCode: 'operation-id-mismatch' });
          if (settled !== null) counts.unknown += 1;
          continue;
        }
        if (isDefiniteBackendRejection(error)) {
          const settled = this.store.settleOperationSubmission(companionId, operation.operationId, claim.token, { state: 'failed', attempts: claim.operation.attempts, lastCheckedAt: claimAt, nextCheckAt: claimAt, errorCode: errorCodeFor('submit', error) });
          if (settled?.state === 'failed') counts.failed += 1;
          continue;
        }
        const settled = this.store.settleOperationSubmission(companionId, operation.operationId, claim.token, { state: 'unknown', attempts: claim.operation.attempts, lastCheckedAt: claimAt, nextCheckAt: claimAt + this.backoffMs(operation.attempts), errorCode: errorCodeFor('submit', error) });
        if (settled !== null) counts.unknown += 1;
      }
    }
    return counts;
  }

  /** Polls due operations serially; an empty queue performs no backend call. */
  async pollDue(now: number = this.clock(), limit: number = MAX_POLL_BATCH): Promise<PollCounts> {
    const counts = emptyPoll();
    const operations = this.store.operationsToPoll(now, limit);
    for (const operation of operations) {
      if (operation.state === 'cancel_requested' || operation.state === 'cleanup_pending') continue;
      if (submissionInFlight(operation) || operation.state === 'unknown' && operation.submittedAt === null && operation.attempts === 0) continue;
      let status: { state: BackendOperationStatus; errorCode?: string };
      try {
        status = await this.backend.operationStatus(operation.companionId, operation.operationId);
      } catch (error) {
        const current = this.store.getOperation(operation.companionId, operation.operationId);
        if (current === null || submissionInFlight(current) || current.state === 'erased' || current.state === 'cleanup_pending' || current.state === 'cancel_requested') {
          continue;
        }
        if (isDefiniteBackendRejection(error)) {
          const updated = this.store.updateOperation(operation.companionId, operation.operationId, { state: 'failed', attempts: operation.attempts + 1, lastCheckedAt: now, nextCheckAt: now, errorCode: errorCodeFor('status', error) });
          if (updated.state === 'failed') counts.failed += 1;
          continue;
        }
        const updated = this.store.updateOperation(operation.companionId, operation.operationId, { state: 'unknown', attempts: operation.attempts + 1, lastCheckedAt: now, nextCheckAt: now + this.backoffMs(operation.attempts), errorCode: errorCodeFor('status', error) });
        if (updated.state === 'unknown') counts.unknown += 1;
        continue;
      }
      counts.polled += 1;
      const current = this.store.getOperation(operation.companionId, operation.operationId);
      if (current === null || submissionInFlight(current) || current.state === 'erased') continue;
      if (current.state === 'cleanup_pending' || current.state === 'cancel_requested') {
        // Revocation may have arrived while the status request was in flight.
        if (status.state === 'completed') this.store.recordOperationCompletion(operation.companionId,operation.operationId,now,{nextCheckAt:now});
        continue;
      }
      const attempts = operation.attempts + 1;
      if (status.state === 'completed') {
        // A completed legacy write may now be disallowed by its source mode.
        // Suppression still keeps remote documents, even when their mode is blocked.
        if (this.shouldEraseDocument(operation)) {
          const updated = this.store.recordOperationCompletion(operation.companionId, operation.operationId, now, { state: 'cleanup_pending', attempts, lastCheckedAt: now, nextCheckAt: now, cleanupState: 'pending' });
          if (updated.state === 'cleanup_pending' && updated.cleanupState === 'pending') counts.cleanupRequested += 1;
        } else {
          const updated = this.store.recordOperationCompletion(operation.companionId, operation.operationId, now, { state: 'completed', attempts, lastCheckedAt: now, nextCheckAt: now, cleanupState: 'not-requested' });
          if (updated.state === 'completed') counts.completed += 1;
        }
        continue;
      }
      if (status.state === 'failed') {
        const updated = this.store.updateOperation(operation.companionId, operation.operationId, { state: 'failed', attempts, lastCheckedAt: now, nextCheckAt: now, errorCode: 'backend-failed' });
        if (updated.state === 'failed') counts.failed += 1;
        continue;
      }
      if (status.state === 'cancelled') {
        const updated = this.store.updateOperation(operation.companionId, operation.operationId, { state: 'cleanup_pending', attempts, lastCheckedAt: now, nextCheckAt: now, cleanupState: 'pending' });
        if (updated.state === 'cleanup_pending' && updated.cleanupState === 'pending') counts.cleanupRequested += 1;
        continue;
      }
      if (status.state === 'not_found') {
        const updated = this.store.updateOperation(operation.companionId, operation.operationId, { state: 'unknown', attempts, lastCheckedAt: now, nextCheckAt: now + this.backoffMs(operation.attempts), errorCode: 'operation-not-found' });
        if (updated.state === 'unknown') counts.unknown += 1;
        continue;
      }
      const nextState = status.state === 'processing' ? 'processing' : 'submitted';
      this.store.updateOperation(operation.companionId, operation.operationId, { state: nextState, attempts, lastCheckedAt: now, nextCheckAt: now + this.backoffMs(operation.attempts), errorCode: null });
    }
    return counts;
  }

  /** Requests cleanup. Cooperative writes finish naturally so their completion remains provable. */
  cancel(companionId: string, operationId: string, now: number = this.clock()): BackendOperation {
    const operation = this.store.getOperation(companionId, operationId);
    if (operation === null) throw new Error('Unknown operation');
    if (operation.state === 'erased') return operation;
    return this.store.updateOperation(companionId, operationId, { state: 'cancel_requested', cleanupState: 'pending', nextCheckAt: now });
  }

  /** Proves each write settled, then erases payload and finally its revoked document. */
  async cleanupDue(now: number = this.clock(), limit: number = MAX_POLL_BATCH): Promise<CleanupCounts> {
    const counts = emptyCleanup();
    for (const operation of this.store.operationsToCleanup(now, limit)) {
      const result = await cleanupOperationPayload(this.store,this.backend,operation,now,attempts => this.backoffMs(attempts),async current => {
        if (!this.shouldEraseDocument(current)) return;
        const location = this.store.companionMemory.indexLocationForOperation(current.companionId,current.operationId);
        if (location !== null && this.materials !== undefined && location.memory !== null) await this.materials.deleteDocument(current.companionId,location.id);
        else if (location !== null) await deleteLocatedDocument(this.backend,location);
        else await this.backend.deleteDocument(current.companionId,current.documentId);
      });
      if (result === 'erased') counts.erased++;
      else if (result === 'unknown') counts.unknown++;
      else if (result === 'blocked') counts.blocked++;
    }
    return counts;
  }

  /** One background pass: poll due operations, then finish due cleanups. Submission is explicit. */
  async runOnce(now: number = this.clock()): Promise<RunCounts> {
    const poll = await this.pollDue(now);
    const cleanup = await this.cleanupDue(now);
    return { poll, cleanup };
  }

  /** Submit, poll and clean up a single companion in one serial pass. */
  async process(companionId: string, now: number = this.clock()): Promise<{ submit: SubmitCounts; poll: PollCounts; cleanup: CleanupCounts }> {
    const submit = await this.submitPending(companionId, now);
    const poll = await this.pollDue(now);
    const cleanup = await this.cleanupDue(now);
    return { submit, poll, cleanup };
  }

  private shouldEraseDocument(operation: BackendOperation): boolean {
    const companionId=operation.companionId;
    const location=this.store.companionMemory.indexLocationForOperation(companionId,operation.operationId);
    if(location?.memory != null) return this.materials?.shouldErase(companionId,location.id) ?? location.cleanupState !== 'not-requested';
    const documentId=location?.source?.eventId ?? operation.documentId;
    const source = this.store.documentStatus(companionId, documentId).source;
    if (source === 'forgotten') return true;
    if (source !== 'active') return false;
    const metadata = this.store.eventMetadata(companionId, documentId);
    return metadata?.learning === 'temporary' || metadata?.mode === 'roleplay';
  }


}
