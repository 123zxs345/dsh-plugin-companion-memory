/** Offline, read-only analysis of native session counters; never print prompt or memory text. */
import {readdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {analyzeMemoryCache,type CacheLogEvent} from '../src/memory/cache-report.ts';
export function readMemoryCacheReport(directory:string){
  const root=join(directory,'harness-sessions');
  const sessions=readdirSync(root,{recursive:true}).map(String).filter(path=>path.endsWith('session.v4.jsonl'))
    .map(path=>readFileSync(join(root,path),'utf8').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as CacheLogEvent));
  return analyzeMemoryCache(sessions);
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){
  if(!process.argv[2])throw new Error('Pass a probe data directory');
  console.log(JSON.stringify(readMemoryCacheReport(resolve(process.argv[2])),null,2));
}
