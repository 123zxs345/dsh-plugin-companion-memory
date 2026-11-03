/** Query relevance only; these limits never assign long-term emotional value. */
export declare const MAX_MEMORY_CANDIDATES = 24;
export declare const DEFAULT_MINIMUM_SIMILARITY = 0.55;
export interface MemoryRetrievalOptions {
    limit?: number;
    minimumSimilarity?: number;
}
export declare function retrievalOptions(options?: MemoryRetrievalOptions): {
    minimumSimilarity: number;
    limit: number;
};
