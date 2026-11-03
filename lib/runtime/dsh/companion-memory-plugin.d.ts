import type { Context, Plugin } from '@deepseek-ai/cordis';
import { type ScopeKey } from '@deepseek-ai/dsh-scope';
import Schema from '@deepseek-ai/schemastery';
import { StateStore } from '../../state/store.ts';
import { type MemoryReviewResult } from '../../memory/reviewer.ts';
import { type UserProfileSnapshot } from '../../memory/user-profile.ts';
import { MemoryMaterialIndex } from '../../memory/material-index.ts';
import type { ProfileModel, ProfileModelRequest, ProfileModelResult } from '../../profile/model-types.ts';
export interface Config {
    dataDir: string;
    companionId?: string;
    name?: string;
    persona?: string;
    /** Zero disables scheduling; manual review remains available. */
    idleReviewSeconds?: number;
    reviewMaxDelaySeconds?: number;
    minimumSimilarity?: number;
    contextTokens?: number;
    candidateBudget?: number;
    maintenanceMode?: 'off' | 'preview' | 'auto';
    hindsightUrl?: string;
    /** Optional fallback for review before a live request is captured. Credentials stay with the host. */
    provider?: string;
    model?: string;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    dataDir: Schema<string, string, "defined">;
    companionId: Schema<string, string, "defined">;
    name: Schema<string, string, "plain">;
    persona: Schema<string, string, "plain">;
    idleReviewSeconds: Schema<number, number, "defined">;
    reviewMaxDelaySeconds: Schema<number, number, "defined">;
    minimumSimilarity: Schema<number, number, "defined">;
    contextTokens: Schema<number, number, "defined">;
    candidateBudget: Schema<number, number, "defined">;
    maintenanceMode: Schema<"auto" | "off" | "preview", "auto" | "off" | "preview", "defined">;
    hindsightUrl: Schema<string, string, "plain">;
    provider: Schema<string, string, "plain">;
    model: Schema<string, string, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    dataDir: Schema<string, string, "defined">;
    companionId: Schema<string, string, "defined">;
    name: Schema<string, string, "plain">;
    persona: Schema<string, string, "plain">;
    idleReviewSeconds: Schema<number, number, "defined">;
    reviewMaxDelaySeconds: Schema<number, number, "defined">;
    minimumSimilarity: Schema<number, number, "defined">;
    contextTokens: Schema<number, number, "defined">;
    candidateBudget: Schema<number, number, "defined">;
    maintenanceMode: Schema<"auto" | "off" | "preview", "auto" | "off" | "preview", "defined">;
    hindsightUrl: Schema<string, string, "plain">;
    provider: Schema<string, string, "plain">;
    model: Schema<string, string, "plain">;
}>>, "plain">;
export declare const name = "companion-memory";
export declare const inject: readonly ['agents', 'systemPrompt', 'tools', 'llm'];
export interface CompanionMemoryController {
    reviewNow(mode?: 'preview' | 'apply'): Promise<MemoryReviewResult>;
    applyPreview(): Promise<MemoryReviewResult>;
    snapshot(): MemoryReviewResult;
    userProfile(): UserProfileSnapshot;
    forget(eventIds: string[]): Promise<{
        outcome: ReturnType<StateStore['forgetEvents']>;
        hostHistoryErased: false;
    }>;
    invalidate(): void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        companionMemory: CompanionMemoryController;
    }
}
export interface CompanionMemoryPluginOptions extends Config {
    /** Supplied stores remain owned by the caller. */
    store?: StateStore;
    index?: MemoryMaterialIndex;
    /** Host budget/meter wrapper. Invoke next(request) to preserve the native llm/stream waterfall. */
    runModel?: (request: ProfileModelRequest, next: ProfileModel) => Promise<ProfileModelResult>;
    isBudgetError?: (error: unknown) => boolean;
    ownerScope?: ScopeKey;
    onReady?: (controller: CompanionMemoryController) => void;
}
/** Loader entry and programmatic host integration share the same owned lifecycle. */
export declare function createCompanionMemoryPlugin(options: CompanionMemoryPluginOptions): Plugin;
export declare const apply: (ctx: Context, config: Config) => AsyncGenerator<() => Promise<void>, any, any>;
declare const _default: {
    name: string;
    inject: readonly ["agents", "systemPrompt", "tools", "llm"];
    Config: Schema<Schemastery.ObjectS<NoInfer<{
        dataDir: Schema<string, string, "defined">;
        companionId: Schema<string, string, "defined">;
        name: Schema<string, string, "plain">;
        persona: Schema<string, string, "plain">;
        idleReviewSeconds: Schema<number, number, "defined">;
        reviewMaxDelaySeconds: Schema<number, number, "defined">;
        minimumSimilarity: Schema<number, number, "defined">;
        contextTokens: Schema<number, number, "defined">;
        candidateBudget: Schema<number, number, "defined">;
        maintenanceMode: Schema<"auto" | "off" | "preview", "auto" | "off" | "preview", "defined">;
        hindsightUrl: Schema<string, string, "plain">;
        provider: Schema<string, string, "plain">;
        model: Schema<string, string, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        dataDir: Schema<string, string, "defined">;
        companionId: Schema<string, string, "defined">;
        name: Schema<string, string, "plain">;
        persona: Schema<string, string, "plain">;
        idleReviewSeconds: Schema<number, number, "defined">;
        reviewMaxDelaySeconds: Schema<number, number, "defined">;
        minimumSimilarity: Schema<number, number, "defined">;
        contextTokens: Schema<number, number, "defined">;
        candidateBudget: Schema<number, number, "defined">;
        maintenanceMode: Schema<"auto" | "off" | "preview", "auto" | "off" | "preview", "defined">;
        hindsightUrl: Schema<string, string, "plain">;
        provider: Schema<string, string, "plain">;
        model: Schema<string, string, "plain">;
    }>>, "plain">;
    apply: typeof apply;
};
export default _default;
