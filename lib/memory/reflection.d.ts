import type { SourceEvent } from '../contracts.ts';
import type { CompanionMemory, CompanionMemoryOperation, CompanionMemoryRevisionRef, CompanionSourceRef, PendingCompanionSource } from '../memory/companion-types.ts';
import type { ProfileModelRequest } from '../profile/model-types.ts';
import type { PromptPrefix } from '../demo/prompt-cache.ts';
import type { HarnessBranch } from '../runtime/harness-context.ts';
import type { UserProfileSnapshot } from './user-profile.ts';
export interface ReviewBlock {
    blockId: string;
    complete: true;
    sources: PendingCompanionSource[];
}
export interface ReviewMaterial {
    memory: CompanionMemory;
    evidence: {
        eventId: string;
        sourceRevision: number;
        sourceRole: SourceEvent['role'];
    }[];
    parents: CompanionMemoryRevisionRef[];
    sources: {
        ref: CompanionSourceRef;
        event: SourceEvent | null;
        detailsUnavailable: boolean;
    }[];
}
export declare const estimateTokens: (value: string) => number;
export declare function estimateRequestTokens(request: ProfileModelRequest): number;
export declare const REVIEW_POLICY_VERSION = "companion-cache-memory-10";
export declare function stageARequest(blocks: ReviewBlock[], persona: string, userProfile?: UserProfileSnapshot, profileMaterials?: ReviewMaterial[], backfillMaterials?: ReviewMaterial[]): ProfileModelRequest;
export declare function stageBRequest(blocks: ReviewBlock[], memories: ReviewMaterial[], stageA: {
    needsReview: boolean;
    topics: string[];
}, persona: string, userProfile?: UserProfileSnapshot): ProfileModelRequest;
export declare function branchReviewA(request: ProfileModelRequest, blocks: ReviewBlock[], prefix?: PromptPrefix): ProfileModelRequest;
export declare function branchReviewB(request: ProfileModelRequest, previous: ProfileModelRequest, answer: string, materials: ReviewMaterial[], branch?: HarnessBranch): ProfileModelRequest;
export declare function parseStageA(text: string): {
    needsReview: boolean;
    topics: string[];
};
export interface ReviewRead extends CompanionMemoryRevisionRef {
    level: 'refined' | 'raw';
    offset?: number;
}
export interface ReviewDisclosure {
    refined: CompanionMemoryRevisionRef[];
    raw: CompanionSourceRef[];
}
/** A bounded, scoped read decision; never accept content or arbitrary source identifiers. */
export declare function parseStageBRead(text: string, scope: CompanionMemoryRevisionRef[]): ReviewRead[] | undefined;
/** The runtime supplies disclosure and requires model summaries. Omission retains legacy direct-parser compatibility. */
export declare function parseStageB(text: string, blocks: ReviewBlock[], materials: ReviewMaterial[], disclosure?: ReviewDisclosure): CompanionMemoryOperation[];
