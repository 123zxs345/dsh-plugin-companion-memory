import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SourceEvent } from '../../contracts.ts';
import type { SessionBindings } from './sessions.ts';
/**
 * Stable namespaced identity for one host-session event position.
 *
 * Content is deliberately excluded: StateStore must detect a changed payload
 * at the same source position as an identity collision, not silently accept it.
 */
export declare function hostSourceId(hostSessionId: string, seq: number): string;
/**
 * Map trusted live DSH events into companion memory source events.
 *
 * Only direct, live, original appends of human user messages, completed
 * assistant text, and tool-result text cross this boundary. Replay prefixes,
 * derived surfaces, runtime context, and non-text content stay out.
 */
export declare function mapSessionEvent(bindings: SessionBindings, session: Pick<Session, 'id' | 'firstLiveSeq'>, event: SessionEvent): SourceEvent | undefined;
