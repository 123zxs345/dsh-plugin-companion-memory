import type { ProfileModelMessage, ProfileModelRequest } from '../profile/model-types.ts';
import type { HarnessBranch } from '../runtime/harness-context.ts';
export interface PromptPrefix {
    system: string;
    messages: ProfileModelMessage[];
    sources?: {
        id: string;
        messageIndex: number;
    }[];
    harness?: HarnessBranch;
}
interface HistoryMessage extends ProfileModelMessage {
    id?: string;
}
interface Entry extends PromptPrefix {
    epoch: number;
    history: HistoryMessage[];
    positions: number[];
}
interface Prepared extends Entry {
    id?: string;
    retain: boolean;
}
/** Mirrors DSH's append-only runtime-context projection. Request-local state only;
 * authoritative event revisions/deletion watermark control reuse. No second disk transcript. */
export declare class ConversationPromptCache {
    private entries;
    prepare(request: ProfileModelRequest): Prepared;
    complete(prepared: Prepared, visibleReply: string): PromptPrefix | undefined;
}
/** Rotate at a turn window boundary instead of dropping one leading message every turn. */
export declare function stableHistoryWindow<T extends {
    role: string;
}>(events: T[]): T[];
export {};
