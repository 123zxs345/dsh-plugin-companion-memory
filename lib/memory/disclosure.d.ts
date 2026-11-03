import type { StateStore } from '../state/store.ts';
import type { SourceEvent } from '../contracts.ts';
import type { CompanionMemory, CompanionMemoryRevisionRef, CompanionSourceRef } from './companion-types.ts';
export interface MemorySummaryContext extends CompanionMemoryRevisionRef {
    summary: string;
    availableLayers: ('refined' | 'raw')[];
    detailsUnavailable?: true;
}
/** Only capacity and identity are checked here; relevance belongs to retrieval/the model. */
export declare function memorySummaryItems(memories: readonly CompanionMemory[], tokenBudget: number, maxItems?: number): MemorySummaryContext[];
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
    sources: (CompanionSourceRef & {
        role: SourceEvent['role'];
        content: string | null;
        occurredAt?: string;
    })[];
    detailsUnavailable: boolean;
    nextOffset: number | null;
}
/** Raw pages contain at most four whole sources; numeric offsets count sources, never characters. */
export declare function readCompanionMemory(options: {
    store: StateStore;
    companionId: string;
    reference: CompanionMemoryRevisionRef;
    level: 'refined' | 'raw';
    offset?: number;
}): RefinedMemoryContext | RawMemoryContext;
