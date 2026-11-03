/** Query relevance only; these limits never assign long-term emotional value. */
export const MAX_MEMORY_CANDIDATES=24;
export const DEFAULT_MINIMUM_SIMILARITY=.55;
export interface MemoryRetrievalOptions {limit?:number;minimumSimilarity?:number}
export function retrievalOptions(options:MemoryRetrievalOptions={}){
  const minimumSimilarity=options.minimumSimilarity??DEFAULT_MINIMUM_SIMILARITY;
  if(!Number.isFinite(minimumSimilarity)||minimumSimilarity<0||minimumSimilarity>1)throw new Error('Invalid memory similarity threshold');
  const requested=options.limit??MAX_MEMORY_CANDIDATES;
  if(!Number.isSafeInteger(requested)||requested<0)throw new Error('Invalid memory candidate limit');
  return {minimumSimilarity,limit:Math.min(MAX_MEMORY_CANDIDATES,requested)};
}
