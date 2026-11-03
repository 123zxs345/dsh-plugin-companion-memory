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
export declare class SessionBindings {
    #private;
    constructor(bindings: readonly CompanionSessionBinding[], blocked?: readonly BlockedSessionRecord[]);
    get(hostSessionId: string): CompanionSessionBinding | undefined;
    /** All live bindings in construction order. */
    list(): readonly CompanionSessionBinding[];
    /** True once the host session was rotated away; it must not send requests. */
    isBlocked(hostSessionId: string): boolean;
    /** Blocked record for a host session, or undefined for a live one. */
    blockedOf(hostSessionId: string): BlockedSessionRecord | undefined;
    /** All blocked session records in construction order. */
    blockedList(): readonly BlockedSessionRecord[];
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
    rotate(oldHostSessionId: string, newHostSessionId: string, stateEpoch: number, reason: string): SessionRotation;
}
