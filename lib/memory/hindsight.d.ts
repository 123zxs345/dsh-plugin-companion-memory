import type { AsyncOperationBackend, BackendOperationStatus, MemoryHit, SourceEvent } from '../contracts.ts';
import type { MemoryIndexLocation } from './companion-types.ts';
import { type MaterialDocument } from './operations.ts';
export interface HindsightRouting {
    operation(companionId: string, operationId: string): {
        kind: 'legacy';
    } | {
        kind: 'location';
        location: MemoryIndexLocation;
    } | null;
    legacyDocument(companionId: string, documentId: string): boolean;
}
export interface HindsightOptions {
    baseUrl: string;
    apiKey?: string;
    timeoutMs?: number;
    /**
     * Scheduler mode for MemoryService. The default is 'sync' because the legacy
     * retain queue and the native async operations share one Hindsight backend and
     * existing callers must not silently switch write paths.
     */
    operationMode?: 'sync' | 'async';
    routing?: HindsightRouting;
}
/** No source text, credentials or upstream error bodies cross the error boundary. */
export declare class MemoryBackendError extends Error {
    /** Present only when an HTTP status was actually observed; absent means timeout, network or invalid response. */
    readonly status?: number;
    constructor(operation: string, status?: number);
}
export declare function bankId(companionId: string): string;
export declare class HindsightBackend implements AsyncOperationBackend {
    private readonly client;
    private readonly transport;
    private readonly timeoutMs;
    readonly operationMode: 'sync' | 'async';
    /** Hindsight 1.1.0 acknowledges cancellation before the current batch has stopped. */
    readonly cancellationGuarantee: 'cooperative';
    private routing?;
    constructor(options: HindsightOptions);
    /** Bind trusted local identities. In this mode unknown operation routes fail closed. */
    setRouting(routing: HindsightRouting): void;
    private operationBank;
    checkMaterialBank(bank: string): Promise<void>;
    submitMaterial(document: MaterialDocument, operationId: string, authorize: () => boolean): Promise<{
        operationId: string;
        state: 'submitted';
    }>;
    recallMaterials(bank: string, query: string, maxTokens: number, minimumSimilarity?: number): Promise<MemoryHit[]>;
    deleteLocatedDocument(location: MemoryIndexLocation): Promise<void>;
    retain(event: SourceEvent): Promise<void>;
    submitRetain(event: SourceEvent, operationId: string): Promise<{
        operationId: string;
        state: 'submitted' | 'processing';
    }>;
    operationStatus(companionId: string, operationId: string): Promise<{
        state: BackendOperationStatus;
        errorCode?: string;
    }>;
    cancelOperation(companionId: string, operationId: string): Promise<boolean>;
    deleteOperationPayload(companionId: string, operationId: string, proof?: {
        neverAttempted?: true;
    }): Promise<boolean>;
    private deleteOperationRecord;
    recall(companionId: string, query: string, maxTokens: number): Promise<MemoryHit[]>;
    deleteDocument(companionId: string, documentId: string): Promise<void>;
    private deleteInBank;
    health(): Promise<boolean>;
    private guard;
}
