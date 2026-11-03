import type { StateStore } from '../state/store.ts';
import type { SourceEvent } from '../contracts.ts';
import type { CompanionMemory, CompanionMemoryRevisionRef, CompanionSourceRef } from './companion-types.ts';

export interface MemorySummaryContext extends CompanionMemoryRevisionRef {
  summary: string;
  availableLayers: ('refined' | 'raw')[];
  detailsUnavailable?:true;
}

/** Only capacity and identity are checked here; relevance belongs to retrieval/the model. */
export function memorySummaryItems(memories: readonly CompanionMemory[], tokenBudget: number, maxItems = 24): MemorySummaryContext[] {
  const result: MemorySummaryContext[] = []; const seen = new Set<string>();
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0 || !Number.isFinite(maxItems) || maxItems <= 0) return result;
  const limit = Math.min(24, Math.floor(maxItems));
  for (const memory of memories) {
    if (result.length >= limit) break;
    if (typeof memory.summary !== 'string' || !memory.summary.trim()) continue;
    const key = JSON.stringify([memory.memoryId, memory.revision]); if (seen.has(key)) continue;
    const item: MemorySummaryContext = {memoryId: memory.memoryId, revision: memory.revision, summary: memory.summary,
      availableLayers:['refined','raw'],...(memory.detailsUnavailable?{detailsUnavailable:true as const}:{})};
    if (Math.ceil(Buffer.byteLength(JSON.stringify([...result, item]), 'utf8') / 3) > tokenBudget) continue;
    result.push(item); seen.add(key);
  }
  return result;
}

export interface RefinedMemoryContext extends CompanionMemoryRevisionRef {
  level: 'refined';
  summary: string | null;
  pinned: boolean;
  meaning: string;
  anchors: string[];
  reason: string;
  view: CompanionMemory['view'];
  status: CompanionMemory['status'];
  certainty: CompanionMemory['certainty'];
  useWhen: string;
  avoidWhen: string;
  detailsUnavailable: boolean;
  sourceRefs: CompanionSourceRef[];
}

export interface RawMemoryContext extends CompanionMemoryRevisionRef {
  level: 'raw';
  sources: (CompanionSourceRef & {role: SourceEvent['role']; content: string | null; occurredAt?: string})[];
  detailsUnavailable: boolean;
  nextOffset: number | null;
}

/** Raw pages contain at most four whole sources; numeric offsets count sources, never characters. */
export function readCompanionMemory(options: {
  store: StateStore; companionId: string; reference: CompanionMemoryRevisionRef; level: 'refined' | 'raw'; offset?: number;
}): RefinedMemoryContext | RawMemoryContext {
  if (options.level !== 'refined' && options.level !== 'raw') throw new Error('Invalid memory level');
  if (options.level === 'refined' && options.offset !== undefined) throw new Error('Offset is only supported for raw memory');
  const snapshot = options.store.companionMemory.disclosureSnapshot(options.companionId, options.reference, options.level === 'raw' ? options.offset ?? 0 : undefined);
  const memory = snapshot.memory; const identity = {memoryId: memory.memoryId, revision: memory.revision};
  if (options.level === 'raw') return {...identity, level: 'raw', sources: snapshot.sources, detailsUnavailable: memory.detailsUnavailable, nextOffset: snapshot.nextOffset};
  return {...identity, level: 'refined', summary:memory.summary??null,pinned:memory.pinned,meaning: memory.meaning, anchors: [...memory.anchors], reason: memory.reason, view: memory.view,
    status: memory.status, certainty: memory.certainty, useWhen: memory.useWhen, avoidWhen: memory.avoidWhen,
    detailsUnavailable: memory.detailsUnavailable, sourceRefs: snapshot.sourceRefs};
}
