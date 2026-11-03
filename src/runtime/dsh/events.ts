import { createHash } from 'node:crypto';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SourceEvent } from '../../contracts.ts';
import type { SessionBindings } from './sessions.ts';

const MAX_CONTENT_LENGTH = 32_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_DATE_MS = 8_640_000_000_000_000;
const SOURCE_ID_NAMESPACE = 'dsh-session-event:v1';

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validSeq(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && !Object.is(value, -0);
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const textBlocks: string[] = [];
  for (const block of content) {
    if (
      block !== null
      && typeof block === 'object'
      && block.type === 'text'
      && typeof block.text === 'string'
      && block.text.trim().length > 0
    ) {
      textBlocks.push(block.text);
    }
  }
  if (textBlocks.length === 0) return undefined;
  const text = textBlocks.join('\n');
  return text.length <= MAX_CONTENT_LENGTH && !text.includes('\u0000') ? text : undefined;
}

/**
 * Stable namespaced identity for one host-session event position.
 *
 * Content is deliberately excluded: StateStore must detect a changed payload
 * at the same source position as an identity collision, not silently accept it.
 */
export function hostSourceId(hostSessionId: string, seq: number): string {
  if (!validIdentifier(hostSessionId)) throw new Error('Invalid host session ID');
  if (!validSeq(seq)) throw new Error('Invalid session event sequence');
  const digest = createHash('sha256')
    .update(JSON.stringify([SOURCE_ID_NAMESPACE, hostSessionId, seq]))
    .digest('hex');
  return `dsh:${digest}`;
}

/**
 * Map trusted live DSH events into companion memory source events.
 *
 * Only direct, live, original appends of human user messages, completed
 * assistant text, and tool-result text cross this boundary. Replay prefixes,
 * derived surfaces, runtime context, and non-text content stay out.
 */
export function mapSessionEvent(
  bindings: SessionBindings,
  session: Pick<Session, 'id' | 'firstLiveSeq'>,
  event: SessionEvent,
): SourceEvent | undefined {
  if (!validSeq(event?.seq) || !validTime(event?.time)) return undefined;
  if (!validSeq(session?.firstLiveSeq)) return undefined;
  if (event.seq < session.firstLiveSeq) return undefined;
  if (event.sourceEventSeqs !== undefined || event.surfaceOp !== 'append') return undefined;

  const hostSessionId = session.id;
  if (!validIdentifier(hostSessionId)) return undefined;
  const binding = bindings.get(hostSessionId);
  if (!binding) return undefined;

  let role: SourceEvent['role'];
  let content: string | undefined;
  let toolVerified: false | undefined;

  switch (event.type) {
    case 'user/message':
      if (event.data.source.kind !== 'user') return undefined;
      role = 'user';
      content = textOf(event.data.content);
      break;
    case 'assistant/message':
      if (event.data.interrupted === true) return undefined;
      role = 'assistant';
      content = textOf(event.data.message.content);
      break;
    case 'tool/result':
      role = 'tool';
      content = textOf(event.data.message.content);
      toolVerified = false;
      break;
    default:
      return undefined;
  }

  if (content === undefined) return undefined;
  const occurredAt = new Date(event.time).toISOString();
  return {
    id: hostSourceId(hostSessionId, event.seq),
    companionId: binding.companionId,
    sessionId: hostSessionId,
    role,
    content,
    occurredAt,
    visibility: 'private',
    ...(toolVerified === undefined ? {} : { toolVerified }),
  };
}
