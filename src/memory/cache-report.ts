/** Provider measurements stay separate from approximate previous-prefix comparisons. No text is returned. */
export interface CacheLogEvent {type:string;time:number;data:unknown}
type Stage='chat'|'memory-a'|'memory-b';
interface Usage {input:number|null;read:number|null;write:number|null;output:number|null}
export interface CacheCall {
  stage:Stage;at:number;inputTokens:number|null;cacheReadTokens:number|null;uncachedInputTokens:number|null;
  outputTokens:number|null;appendedTextChars:number;priorPrefixTokensEstimate:number|null;prefixReuseRateEstimate:number|null;
}
interface Totals {calls:number;measuredCalls:number;inputTokens:number;cacheReadTokens:number;uncachedInputTokens:number;hitRate:number|null}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const count=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
function usage(event:CacheLogEvent):Usage {
  const u=object(object(event.data).usage),input=count(u.inputTokens),read=count(u.cacheReadTokens),write=count(u.cacheWriteTokens);
  return {input:input===null?null:input+(read??0)+(write??0),read,write,output:count(u.outputTokens)};
}
function text(event:CacheLogEvent):string {
  const outer=object(event.data),data=event.type==='tool/result'?object(outer.message):outer;if(!Array.isArray(data.content))return '';
  return data.content.map(block=>{const b=object(block);return b.type==='text'&&typeof b.text==='string'?b.text:'';}).join('');
}
function total(calls:CacheCall[]):Totals {
  const measured=calls.filter(c=>c.inputTokens!==null&&c.cacheReadTokens!==null);
  const input=measured.reduce((n,c)=>n+c.inputTokens!,0),read=measured.reduce((n,c)=>n+c.cacheReadTokens!,0);
  return {calls:calls.length,measuredCalls:measured.length,inputTokens:input,cacheReadTokens:read,uncachedInputTokens:input-read,hitRate:input?read/input:null};
}
export function analyzeMemoryCache(sessions:readonly (readonly CacheLogEvent[])[]) {
  const calls:CacheCall[]=[];
  for(const rows of sessions){
    // Forks may contain nested seeds. Only records after the final seed boundary are new provider calls.
    const boundary=rows.findLastIndex(row=>row.type==='session/end-seed');
    const prior=rows.slice(0,boundary+1).findLast(row=>row.type==='assistant/message');
    let previous=prior?usage(prior):undefined,stage:Stage='chat',appendedTextChars=0;
    for(const event of rows.slice(boundary+1)){
      if(event.type==='user/message'){
        const content=text(event);appendedTextChars+=content.length;
        if(content.startsWith('【后台记忆整理任务 A】'))stage='memory-a';
        else if(content.startsWith('【后台记忆整理任务 B】'))stage='memory-b';
      }else if(event.type==='tool/result')appendedTextChars+=text(event).length;
      if(event.type!=='assistant/message')continue;
      const u=usage(event),measured=u.read!==null&&u.write!==null&&u.input!==null;
      const prefix=previous&&previous.input!==null&&previous.read!==null&&previous.write!==null&&previous.output!==null?previous.input+previous.output:null;
      // Cache includes all provider prefix matches; do not report impossible coverage >100%.
      const rate=measured&&prefix!==null&&prefix>0&&u.read!<=prefix?u.read!/prefix:null;
      calls.push({stage,at:event.time,inputTokens:u.input,cacheReadTokens:measured?u.read:null,
        uncachedInputTokens:measured?u.input!-u.read!:null,outputTokens:u.output,appendedTextChars,
        priorPrefixTokensEstimate:prefix,prefixReuseRateEstimate:rate});
      previous=u;appendedTextChars=0;
    }
  }
  calls.sort((a,b)=>a.at-b.at);
  return {calls,total:total(calls),byStage:Object.fromEntries((['chat','memory-a','memory-b'] as const).map(stage=>[stage,total(calls.filter(c=>c.stage===stage))])) as Record<Stage,Totals>,
    estimateNote:'已有前缀复用率为估算：以种子/上一次请求的实测输入+输出作为分母，缓存命中数作分子；序列化边界与缓存其他公共前缀会影响该比较，不能当作精确覆盖率。新增输入只列文本字符数，不冒充 Token。'};
}
