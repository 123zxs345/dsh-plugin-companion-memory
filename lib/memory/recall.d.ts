import type { StateStore } from '../state/store.ts';
import type { CompanionMemory } from './companion-types.ts';
import type { MemoryMaterialIndex, MaterialRecallHit } from './material-index.ts';
import { type MemoryRetrievalOptions } from './retrieval-policy.ts';
export interface CompanionMemoryContext {
    memoryId: string;
    revision: number;
    meaning: string;
    anchors: string[];
    reason: string;
    view: CompanionMemory['view'];
    status: CompanionMemory['status'];
    certainty: CompanionMemory['certainty'];
    useWhen: string;
    avoidWhen: string;
    detailsUnavailable: boolean;
}
/** Local model retrieval supplies relevance. This layer checks identity and validity only. */
export declare function recallCompanionCandidates(options: {
    store: StateStore;
    companionId: string;
    query: string;
    tokenBudget: number;
    index?: MemoryMaterialIndex;
} & MemoryRetrievalOptions): Promise<MaterialRecallHit[]>;
export declare function recallCompanionMemories(options: Parameters<typeof recallCompanionCandidates>[0]): Promise<CompanionMemory[]>;
/** Capacity limits bound a model request; no score/age/keyword rule assigns memory value. */
export declare function memoryContextItems(memories: readonly CompanionMemory[], tokenBudget: number, maxItems?: number): CompanionMemoryContext[];
export declare const MEMORY_USAGE_GUIDANCE = "\u8BB0\u5FC6\u662F\u7406\u89E3\u76F8\u5904\u7684\u80CC\u666F\uFF0C\u4E0D\u5FC5\u6BCF\u6B21\u8BF4\u51FA\u6765\u3002\u521D\u59CB memories \u548C recall_memory \u53EA\u63D0\u4F9B\u4E0E\u672C\u6B21\u67E5\u8BE2\u76F8\u4F3C\u5EA6\u8FBE\u6807\u7684\u7B80\u77ED\u603B\u7ED3\uFF0C\u6700\u591A24\u6761\uFF0C\u5141\u8BB80\u6761\u3002\u9700\u8981\u4F7F\u7528\u67D0\u6761\u65F6\u81EA\u884C\u8C03\u7528 read_memory(level:\"refined\") \u67E5\u770B\u63D0\u70BC\u8BB0\u5FC6\u3001\u5FC5\u8981\u539F\u8BDD\u548C\u9002\u7528\u8FB9\u754C\uFF1B\u4ECD\u9700\u6838\u5BF9\u5177\u4F53\u8FC7\u7A0B\u6216\u63AA\u8F9E\u65F6\u518D\u8BFB level:\"raw\"\uFF0C\u6709 nextOffset \u53EF\u7EE7\u7EED\u7FFB\u9875\u3002\u65E0\u9700\u673A\u68B0\u5C55\u5F00\u6240\u6709\u5019\u9009\uFF0C\u6458\u8981\u5DF2\u8DB3\u591F\u65F6\u4E5F\u53EF\u4E0D\u5C55\u5F00\u3002\u76F8\u4F3C\u5EA6\u53EA\u8868\u793A\u672C\u6B21\u67E5\u8BE2\u76F8\u5173\uFF0C\u4E0D\u4EE3\u8868\u957F\u671F\u91CD\u8981\u6027\u3002\u63A8\u6D4B\u4E0D\u80FD\u5F53\u4E8B\u5B9E\uFF0C\u9075\u5B88 useWhen/avoidWhen\uFF1B\u539F\u6587\u5DF2\u6DE1\u53BB\u65F6\u4F9D\u7167\u73B0\u5B58\u63D0\u70BC\u5185\u5BB9\uFF0C\u4E0D\u8865\u9020\u7EC6\u8282\u3002";
