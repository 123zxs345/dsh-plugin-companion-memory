import type { StateStore } from '../state/store.ts';
import type { ProfileModel, ProfileModelRequest } from '../profile/model-types.ts';
import type { PromptPrefix } from '../demo/prompt-cache.ts';
import type { CompanionMemoryRevisionRef } from './companion-types.ts';
import type { MemoryMaterialIndex } from './material-index.ts';
export interface ReviewSettings {
    persona: string;
    provider: string;
    baseUrl: string;
    model: string;
    maintenanceMode: 'off' | 'preview' | 'auto';
    candidateBudget: number;
    minimumSimilarity?: number;
}
export type CompanionReviewSettings = ReviewSettings;
export interface MemoryReviewResult {
    status: 'idle' | 'preview' | 'applied' | 'paused' | 'budget-exceeded' | 'error';
    message: string;
    operations: unknown[];
    createdAt: string;
    /** More unassessed pages remain; already-deferred/failed evidence never triggers this. */
    hasMore?: boolean;
}
export interface CompanionMemoryReviewerOptions {
    store: StateStore;
    companionId: string;
    model: ProfileModel;
    getSettings: () => CompanionReviewSettings;
    index: () => MemoryMaterialIndex | undefined;
    persistenceDir: string;
    getPrefix?: () => PromptPrefix | undefined;
    onPresented?: (references: CompanionMemoryRevisionRef[]) => void;
    /** Compatibility resource checks; production model ports already enforce the shared money budget. */
    paused?: () => boolean;
    allowMaterial?: (request: ProfileModelRequest) => boolean;
    isBudgetError?: (error: unknown) => boolean;
}
/** Semantic decisions belong exclusively to the shared main model. This class schedules and validates them. */
export declare class CompanionMemoryReviewer {
    private readonly options;
    private readonly journal;
    private lane;
    private current;
    private deletionWatermark;
    constructor(options: CompanionMemoryReviewerOptions);
    private serial;
    invalidate(): void;
    snapshot(): MemoryReviewResult;
    private blocks;
    private material;
    private dependency;
    private quietKey;
    private valid;
    private assertCurrent;
    private restoredMaterials;
    private profileMaterials;
    private checkMaterial;
    private backfill;
    private inheritedReads;
    private replay;
    private operations;
    private appendRead;
    private candidates;
    review(mode?: 'preview' | 'apply', automatic?: boolean): Promise<MemoryReviewResult>;
    applyPreview(): Promise<MemoryReviewResult>;
    private commitPreview;
}
