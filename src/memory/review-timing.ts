/** Local dispatch target, not a promise about provider cache eviction or memory value. */
export class ReviewTiming {
  private first:number|undefined;
  private last:number|undefined;
  private retryNotBefore:number|undefined;
  complete(at=Date.now()):void {
    if(!Number.isFinite(at))throw new Error('Invalid completed-exchange time');
    this.first=this.first===undefined?at:Math.min(this.first,at);
    this.last=this.last===undefined?at:Math.max(this.last,at);
  }
  dueAt(idleSeconds:number,maxDelaySeconds:number):number|null {
    if(this.first===undefined||this.last===undefined||idleSeconds<=0)return null;
    return Math.max(this.retryNotBefore??0,Math.min(this.last+idleSeconds*1000,this.first+maxDelaySeconds*1000));
  }
  due(now:number,idleSeconds:number,maxDelaySeconds:number):boolean {
    const at=this.dueAt(idleSeconds,maxDelaySeconds);return at!==null&&now>=at;
  }
  retryAfter(delayMs:number,now=Date.now()):void {
    if(!Number.isFinite(delayMs)||delayMs<0)throw new Error('Invalid review retry delay');
    this.complete(now);this.retryNotBefore=now+delayMs;
  }
  reset():void {this.first=undefined;this.last=undefined;this.retryNotBefore=undefined;}
}
