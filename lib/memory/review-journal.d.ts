import type { CompanionMemoryRevisionRef } from './companion-types.ts';
/** Only model outputs and dependency identities live here, never copied chat histories or native sessions. */
export interface ReviewJournalEntry {
    key: string;
    epoch: number;
    a?: string;
    b?: string;
    materialRefs?: CompanionMemoryRevisionRef[];
    materialDigest?: string;
    /** Already visible as complete profile or dedicated summary backfill in A. */
    initialRefs?: CompanionMemoryRevisionRef[];
    backfillRefs?: CompanionMemoryRevisionRef[];
    /** Only validated model read decisions; their result bodies are reconstructed locally. */
    reads?: string[];
    /** Verified native read_memory calls already present in the inherited chat. No result bodies. */
    inheritedReads?: string[];
    planId: string;
    failed?: boolean;
}
interface JournalData {
    version: 1;
    companionId: string;
    cursor: number;
    entry?: ReviewJournalEntry;
    quietKey?: string;
    checkedBackfill?: {
        epoch: number;
        refs: CompanionMemoryRevisionRef[];
    };
}
export declare class ReviewJournal {
    readonly path: string;
    data: JournalData;
    constructor(directory: string, companionId: string);
    save(): void;
    clear(): void;
}
export {};
