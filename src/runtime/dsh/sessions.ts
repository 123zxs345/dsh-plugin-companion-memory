export interface CompanionSessionBinding {
  readonly hostSessionId: string;
  readonly companionId: string;
  readonly logicalChatId: string;
}

/**
 * A host session that was invalidated and must never send another request.
 *
 * DSH exposes no public API to rewrite model-visible messages that already
 * exist in a host session, so the only honest recovery is to stop using the
 * old session and continue in a clean successor that shares the logical chat.
 */
export interface BlockedSessionRecord {
  readonly hostSessionId: string;
  readonly companionId: string;
  readonly logicalChatId: string;
  /** State epoch observed when the session was blocked. */
  readonly stateEpoch: number;
  readonly reason: string;
}

/** Result of rotating one blocked host session onto a clean successor. */
export interface SessionRotation {
  /**
   * Immutable snapshot to use when mounting the successor: it contains the
   * successor binding and the blocked record for the old host.
   *
   * The bindings instance that produced this rotation is also updated in
   * place (see {@link SessionBindings.rotate}): the old host is removed from
   * its live bindings and recorded as blocked, so plugins already mounted
   * with that instance fail closed on their next pre-step instead of sending
   * another model request.
   */
  readonly bindings: SessionBindings;
  readonly previous: CompanionSessionBinding;
  readonly successor: CompanionSessionBinding;
  readonly blocked: BlockedSessionRecord;
}

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_REASON_LENGTH = 512;

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function detachBinding(input: CompanionSessionBinding): CompanionSessionBinding {
  if (input === null || typeof input !== 'object') {
    throw new Error('Invalid session binding');
  }
  validateIdentifier(input.hostSessionId, 'host session ID');
  validateIdentifier(input.companionId, 'companion ID');
  validateIdentifier(input.logicalChatId, 'logical chat ID');
  return Object.freeze({
    hostSessionId: input.hostSessionId,
    companionId: input.companionId,
    logicalChatId: input.logicalChatId
  });
}

/**
 * Developer-configured host-session bindings.
 *
 * Construction is the only binding path. A missing host session stays unbound;
 * it is never inferred from a companion, chat, or runtime session.
 *
 * The public read API is immutable: list(), get(), isBlocked() and
 * blockedList() never mutate a caller-visible collection. Rotation (see
 * {@link rotate}) is the one deliberate exception because safety requires it:
 * it removes the old host from THIS instance's live bindings and records it as
 * blocked, so a plugin that was mounted earlier with this same instance (a
 * resumed/kept-alive agent) observes the block on its next pre-step and fails
 * closed instead of sending another model request. The returned rotation
 * bindings are a separate snapshot for mounting the successor.
 */
export class SessionBindings {
  readonly #byHost: Map<string, CompanionSessionBinding>;
  readonly #blocked: Map<string, BlockedSessionRecord>;

  constructor(
    bindings: readonly CompanionSessionBinding[],
    blocked: readonly BlockedSessionRecord[] = []
  ) {
    const byHost = new Map<string, CompanionSessionBinding>();
    if (!Array.isArray(bindings)) throw new Error('Invalid session bindings');
    if (!Array.isArray(blocked)) throw new Error('Invalid blocked session records');

    for (const input of bindings) {
      const detached = detachBinding(input);
      if (byHost.has(detached.hostSessionId)) {
        throw new Error(`Duplicate host session ID: ${detached.hostSessionId}`);
      }
      byHost.set(detached.hostSessionId, detached);
    }

    const blockedByHost = new Map<string, BlockedSessionRecord>();
    for (const input of blocked) {
      if (input === null || typeof input !== 'object') {
        throw new Error('Invalid blocked session record');
      }
      validateIdentifier(input.hostSessionId, 'host session ID');
      validateIdentifier(input.companionId, 'companion ID');
      validateIdentifier(input.logicalChatId, 'logical chat ID');
      if (
        typeof input.reason !== 'string'
        || input.reason.length === 0
        || input.reason.length > MAX_REASON_LENGTH
      ) {
        throw new Error('Invalid blocked session reason');
      }
      if (!Number.isSafeInteger(input.stateEpoch) || input.stateEpoch < 0) {
        throw new Error('Invalid blocked session epoch');
      }
      if (blockedByHost.has(input.hostSessionId)) {
        throw new Error(`Duplicate blocked host session ID: ${input.hostSessionId}`);
      }
      // A blocked record normally describes a host session that was rotated
      // away and is deliberately absent from the live bindings. When the host
      // is still bound (config-supplied records), the record must match it so
      // one host session can never be both live and blocked under different
      // companion/chat identities.
      const binding = byHost.get(input.hostSessionId);
      if (
        binding !== undefined
        && (
          binding.companionId !== input.companionId
          || binding.logicalChatId !== input.logicalChatId
        )
      ) {
        throw new Error(
          `Blocked host session does not match its binding: ${input.hostSessionId}`
        );
      }
      blockedByHost.set(input.hostSessionId, Object.freeze({
        hostSessionId: input.hostSessionId,
        companionId: input.companionId,
        logicalChatId: input.logicalChatId,
        stateEpoch: input.stateEpoch,
        reason: input.reason
      }));
    }

    this.#byHost = byHost;
    this.#blocked = blockedByHost;
    Object.freeze(this);
  }

  get(hostSessionId: string): CompanionSessionBinding | undefined {
    return this.#byHost.get(hostSessionId);
  }

  /** All live bindings in construction order. */
  list(): readonly CompanionSessionBinding[] {
    return Object.freeze([...this.#byHost.values()]);
  }

  /** True once the host session was rotated away; it must not send requests. */
  isBlocked(hostSessionId: string): boolean {
    return this.#blocked.has(hostSessionId);
  }

  /** Blocked record for a host session, or undefined for a live one. */
  blockedOf(hostSessionId: string): BlockedSessionRecord | undefined {
    return this.#blocked.get(hostSessionId);
  }

  /** All blocked session records in construction order. */
  blockedList(): readonly BlockedSessionRecord[] {
    return Object.freeze([...this.#blocked.values()]);
  }

  /**
   * Mark one host session blocked and bind a clean successor.
   *
   * The successor receives the same companion and logical chat ID; only the
   * host session ID changes, so the UI keeps showing one conversation while
   * the host starts a fresh message history.
   *
   * The receiver is mutated in place on success: the old host disappears from
   * its live bindings and is added to its blocked records. This is what makes
   * blocked enforcement runtime-visible to already-mounted plugins; callers
   * MUST keep passing the same bindings instance to the plugin they want
   * guarded, rather than building a second unrelated SessionBindings. The
   * returned {@link SessionRotation.bindings} is the snapshot that should be
   * used to mount the successor.
   *
   * @param oldHostSessionId - currently bound, not yet blocked host session.
   * @param newHostSessionId - fresh host session ID for the successor.
   * @param stateEpoch - epoch that invalidated the old session; must be safe.
   * @param reason - human-readable invalidation reason.
   */
  rotate(
    oldHostSessionId: string,
    newHostSessionId: string,
    stateEpoch: number,
    reason: string
  ): SessionRotation {
    validateIdentifier(oldHostSessionId, 'host session ID');
    validateIdentifier(newHostSessionId, 'host session ID');
    if (oldHostSessionId === newHostSessionId) {
      throw new Error('A successor host session must differ from the blocked one');
    }
    if (!Number.isSafeInteger(stateEpoch) || stateEpoch < 0) {
      throw new Error('Invalid rotation state epoch');
    }
    if (
      typeof reason !== 'string'
      || reason.length === 0
      || reason.length > MAX_REASON_LENGTH
    ) {
      throw new Error('Invalid rotation reason');
    }
    const previous = this.#byHost.get(oldHostSessionId);
    if (previous === undefined) {
      throw new Error(`Unknown host session binding: ${oldHostSessionId}`);
    }
    if (this.#blocked.has(oldHostSessionId)) {
      throw new Error(`Host session is already blocked: ${oldHostSessionId}`);
    }
    if (this.#byHost.has(newHostSessionId)) {
      throw new Error(`Successor host session is already bound: ${newHostSessionId}`);
    }
    if (this.#blocked.has(newHostSessionId)) {
      // A blocked host session must never become model-reachable again: reusing
      // its ID as a successor would create a live binding whose requests the
      // invalidation barrier still considers blocked.
      throw new Error(`Successor host session is blocked: ${newHostSessionId}`);
    }

    const successor = Object.freeze({
      hostSessionId: newHostSessionId,
      companionId: previous.companionId,
      logicalChatId: previous.logicalChatId
    });
    const blocked = Object.freeze({
      hostSessionId: previous.hostSessionId,
      companionId: previous.companionId,
      logicalChatId: previous.logicalChatId,
      stateEpoch,
      reason
    });
    const live = [...this.#byHost.values()].filter(
      binding => binding.hostSessionId !== oldHostSessionId
    );
    const bindings = new SessionBindings(
      [...live, successor],
      [...this.#blocked.values(), blocked]
    );
    // Build succeeded: make the block observable to plugins that were already
    // mounted with THIS bindings object. Without this in-place update a plugin
    // mounted before rotation keeps its stale live view and would happily send
    // the next model request from the invalidated host session.
    this.#blocked.set(previous.hostSessionId, blocked);
    this.#byHost.delete(previous.hostSessionId);
    return Object.freeze({ bindings, previous, successor, blocked });
  }
}
