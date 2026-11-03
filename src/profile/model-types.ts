import type {HarnessBranch} from '../runtime/harness-context.ts';
/** Provider-neutral one-shot ports shared by extraction and review. */
export interface ProfileModelImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Request-local image bytes. Never persist these in conversation history. */
  data: string;
}

export interface ProfileModelRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  images?: ProfileModelImage[];
  /** Provider-native ordered messages; prompt remains the task's structured input. */
  messages?: ProfileModelMessage[];
  task?: 'memory-a'|'memory-b';
  conversation?: {id:string;epoch:number;requestId?:string};
  /** An official session fork used by background memory work; never serialized as prompt data. */
  harness?: {branch:HarnessBranch};
}

export interface ProfileModelMessage {role:'user'|'assistant';content:string}

export interface ProfileModelResult {
  text: string;
  model: string;
  /** Native function requests supported by injected transports; the Harness executes them. */
  toolCalls?:{id:string;name:string;arguments:Record<string,unknown>}[];
  harness?:HarnessBranch;
  usage?: { inputTokens: number | null; outputTokens: number | null;uncachedInputTokens?:number;cacheReadTokens?:number;cacheWriteTokens?:number };
}

export type ProfileModel = (request: ProfileModelRequest) => Promise<ProfileModelResult>;

export type ProfileReviewVerdict = 'approve' | 'reject' | 'defer';

export interface ProfileReviewDecision {
  candidateId: string;
  verdict: ProfileReviewVerdict;
  reason: string;
}
