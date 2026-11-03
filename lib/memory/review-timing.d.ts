/** Local dispatch target, not a promise about provider cache eviction or memory value. */
export declare class ReviewTiming {
    private first;
    private last;
    private retryNotBefore;
    complete(at?: number): void;
    dueAt(idleSeconds: number, maxDelaySeconds: number): number | null;
    due(now: number, idleSeconds: number, maxDelaySeconds: number): boolean;
    retryAfter(delayMs: number, now?: number): void;
    reset(): void;
}
