import type { StateStore } from '../state/store.ts';
import type { CompanionSourceRef } from './companion-types.ts';
import type { CompanionMemoryContext } from './recall.ts';
export interface UserProfileEntry extends CompanionMemoryContext {
    pinned: boolean;
    sourceRefs: CompanionSourceRef[];
}
export interface UserProfileSnapshot {
    revision: string;
    entries: UserProfileEntry[];
}
/** A projection of model-authored memories, never a second independently stored profile. */
export declare function readCompanionUserProfile(store: StateStore, companionId: string): UserProfileSnapshot;
