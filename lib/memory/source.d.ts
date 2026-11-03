import type { SourceEvent } from '../contracts.ts';
/** Shared admission rule for long-term storage and recall. Missing mode metadata keeps legacy defaults. */
export declare function isLongTermSourceAllowed(event: Pick<SourceEvent, 'role' | 'visibility' | 'toolVerified' | 'learning' | 'contentMode'>): boolean;
