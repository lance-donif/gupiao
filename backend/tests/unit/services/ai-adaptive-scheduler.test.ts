import { describe,expect,it,vi,afterEach } from 'vitest';
import { AiAdaptiveScheduler,type AiCandidate } from '../../../src/services/ai-adaptive-scheduler.js';
import { MemoryAiSchedulerStore } from '../../../src/services/ai-scheduler-store.js';
import { AiCallFailure,AiNeedsAttentionError,AiSplitRequiredError,classifyAiHttp,retryAfter } from '../../../src/services/ai-scheduling-errors.js';
import type { IAiProviderConfig } from '../../../src/services/ai-provider-config.js';
import { readOpenAiStream } from '../../../src/lib/openai-stream.js';

function setup(maximum=5, extra:Partial<IAiProviderConfig>={}) {
  const config:IAiProviderConfig={providers:[{id:'p',baseUrl:'https://p.test/v1',apiKey:'private',limits:{initialConcurrency:2,maxConcurrency:maximum,minSpacingMs:1},models:[{id:'a',limits:{minSpacingMs:1}},{id:'b',limits:{minSpacingMs:1}}]}],...extra};
  const candidates:AiCandidate[]=config.providers.flatMap(provider=>provider.models.map(model=>({provider,model,serialized:'{}'})));
  const store=new MemoryAiSchedulerStore();let now=0;
  const scheduler=new AiAdaptiveScheduler(config,store,()=>now,()=>0);
  return {config,candidates,store,scheduler,clock:()=>now,advance:(ms:number)=>{now+=ms;}};
}
afterEach(()=>vi.useRealTimers());
describe('adaptive AI scheduling',()=>{
  it('shares two provider slots across models and independent clients',async()=>{
    const s=setup();const first=await s.scheduler.acquire(s.candidates);s.advance(2);
    const secondClient=new AiAdaptiveScheduler(s.config,s.store,s.clock);
    const second=await secondClient.acquire(s.candidates);s.advance(2);
    expect(first.lease).toBeDefined();expect(second.lease).toBeDefined();
    expect((await s.scheduler.acquire(s.candidates)).lease).toBeUndefined();
    await s.scheduler.finish(first.candidate!,first.lease!);s.advance(2);
    expect((await secondClient.acquire(s.candidates)).lease).toBeDefined();
  });
  it.each([2,5])('grows cautiously and obeys configured maximum %i',async maximum=>{
    const s=setup(maximum);
    for(let i=0;i<60;i++){s.advance(15000);const slot=await s.scheduler.acquire(s.candidates);await s.scheduler.finish(slot.candidate!,slot.lease!);}
    expect(s.store.snapshot.health['provider:p'].capacity).toBe(maximum);
  });
  it.each([2,5])('learns an unknown server concurrency limit of %i',async serverLimit=>{
    const s=setup(5);let rejections=0;let peak=0;
    for(let round=0;round<45;round++) {
      s.advance(65000);
      const slots=[];
      for(let i=0;i<6;i++) {
        const slot=await s.scheduler.acquire(s.candidates);s.advance(2);
        if(!slot.lease)break;
        slots.push(slot);peak=Math.max(peak,slots.length);
        if(slots.length>serverLimit) {
          rejections++;await s.scheduler.finish(slot.candidate!,slot.lease,new AiCallFailure('rate',429,s.clock()+60000));
          slots.pop();break;
        }
      }
      for(const slot of slots)await s.scheduler.finish(slot.candidate!,slot.lease!);
    }
    expect(peak).toBeLessThanOrEqual(5);
    if(serverLimit===2){expect(rejections).toBeGreaterThan(0);expect(peak).toBe(3);}
    else {expect(rejections).toBe(0);expect(peak).toBe(5);}
  });
  it('halves capacity on 429 and respects Retry-After across all provider models',async()=>{
    const s=setup();const slot=await s.scheduler.acquire(s.candidates);
    await s.scheduler.finish(slot.candidate!,slot.lease!,new AiCallFailure('rate',429,60000));
    expect(s.store.snapshot.health['provider:p'].capacity).toBe(1);
    s.advance(59000);expect((await s.scheduler.acquire(s.candidates)).lease).toBeUndefined();
    s.advance(1001);expect((await s.scheduler.acquire(s.candidates)).lease).toBeDefined();
  });
  it('uses other providers when one is busy',async()=>{
    const s=setup();const p2={...s.config.providers[0],id:'second'};
    const config={providers:[...s.config.providers,p2]};
    const scheduler=new AiAdaptiveScheduler(config,s.store,()=>1);
    const candidates=config.providers.flatMap(provider=>provider.models.map(model=>({provider,model,serialized:'{}'})));
    const first=await scheduler.acquire(candidates);const second=await scheduler.acquire(candidates);
    expect(first.candidate?.provider.id).toBe('p');expect(second.candidate?.provider.id).toBe('second');
  });
  it('shares a quota group across different provider entries',async()=>{
    const s=setup();const config={quotaGroups:{account:{initialConcurrency:1,maxConcurrency:1,minSpacingMs:1}},providers:[{...s.config.providers[0],quotaGroup:'account'},{...s.config.providers[0],id:'other',quotaGroup:'account'}]};
    let now=0;const scheduler=new AiAdaptiveScheduler(config,s.store,()=>now);
    const candidates=config.providers.flatMap(provider=>provider.models.map(model=>({provider,model,serialized:'{}'})));
    expect((await scheduler.acquire(candidates)).lease).toBeDefined();now=10;
    expect((await scheduler.acquire(candidates)).lease).toBeUndefined();
  });
  it('disables missing models but keeps sibling models available',async()=>{
    const s=setup();const slot=await s.scheduler.acquire(s.candidates);
    await s.scheduler.finish(slot.candidate!,slot.lease!,new AiCallFailure('missing_model',404));s.advance(2);
    expect((await s.scheduler.acquire(s.candidates)).candidate?.model.id).toBe('b');
  });
  it('invalid credentials disable the provider and credential rotation recovers it',async()=>{
    const s=setup();const slot=await s.scheduler.acquire(s.candidates);
    await s.scheduler.finish(slot.candidate!,slot.lease!,new AiCallFailure('auth',401));s.advance(2);
    expect((await s.scheduler.acquire(s.candidates)).unavailable).toBe(true);
    const rotated=s.candidates.map(c=>({...c,provider:{...c.provider,apiKey:'rotated'}}));
    expect((await s.scheduler.acquire(rotated)).lease).toBeDefined();
  });
  it('keeps other credentials in a quota group usable after an authentication failure',async()=>{
    const s=setup();
    const config={quotaGroups:{shared:{minSpacingMs:1}},providers:[{...s.config.providers[0],quotaGroup:'shared'},{...s.config.providers[0],id:'other',apiKey:'other-key',quotaGroup:'shared'}]};
    const scheduler=new AiAdaptiveScheduler(config,s.store,s.clock);
    const candidates=config.providers.flatMap(provider=>provider.models.map(model=>({provider,model,serialized:'{}'})));
    const slot=await scheduler.acquire(candidates);
    await scheduler.finish(slot.candidate!,slot.lease!,new AiCallFailure('auth',401));s.advance(2);
    expect((await scheduler.acquire(candidates)).candidate?.provider.id).toBe('other');
  });
  it('does not degrade provider health for content rejection',async()=>{
    const s=setup();const slot=await s.scheduler.acquire(s.candidates);
    await s.scheduler.finish(slot.candidate!,slot.lease!,new AiCallFailure('refusal'));
    expect(s.store.snapshot.health['provider:p']).toMatchObject({validRate:0.8,failures:0,cooldownUntil:0});
  });
  it('opens a circuit after three failures and permits only one recovery probe',async()=>{
    const s=setup();
    for(let i=0;i<3;i++){const slot=await s.scheduler.acquire(s.candidates);await s.scheduler.finish(slot.candidate!,slot.lease!,new AiCallFailure('network',504));s.advance(65000);}
    const probe=await s.scheduler.acquire(s.candidates);s.advance(2);
    expect(probe.lease).toBeDefined();expect((await s.scheduler.acquire(s.candidates)).lease).toBeUndefined();
    await s.scheduler.finish(probe.candidate!,probe.lease!);
    expect(s.store.snapshot.health['provider:p'].probing).toBe(false);
  });
  it('does not split on rate limits and bounds requests without a workflow',async()=>{
    const s=setup(5,{scheduling:{maxAttempts:1}});
    await expect(s.scheduler.execute(s.candidates,async()=>{throw new AiCallFailure('rate',429);})).rejects.toBeInstanceOf(AiNeedsAttentionError);
  });
  it('accounts for per-minute and daily quotas',async()=>{
    const s=setup();const candidates=s.candidates.map(c=>({...c,provider:{...c.provider,limits:{...c.provider.limits,rpm:1,dailyRequests:2}}}));
    const first=await s.scheduler.acquire(candidates);await s.scheduler.finish(first.candidate!,first.lease!);s.advance(2);
    expect((await s.scheduler.acquire(candidates)).lease).toBeUndefined();s.advance(60000);
    const second=await s.scheduler.acquire(candidates);await s.scheduler.finish(second.candidate!,second.lease!);s.advance(60001);
    expect((await s.scheduler.acquire(candidates)).waitMs).toBeGreaterThan(60000);
  });
  it('reclaims expired leases after a crashed client',async()=>{
    const s=setup();await s.scheduler.acquire(s.candidates);s.advance(2);await s.scheduler.acquire(s.candidates);
    s.advance(211000);expect((await s.scheduler.acquire(s.candidates)).lease).toBeDefined();expect(s.store.snapshot.leases).toHaveLength(1);
  });
  it('splits inputs which exceed every available model context limit before sending',async()=>{
    const s=setup();let calls=0;
    const candidates=s.candidates.map(candidate=>({...candidate,model:{...candidate.model,limits:{contextTokens:10}}}));
    await expect(s.scheduler.execute(candidates,async()=>{calls++;return true;})).rejects.toBeInstanceOf(AiSplitRequiredError);
    expect(calls).toBe(0);
  });
});
describe('AI error classification and streams',()=>{
  it('recognizes embedded stream limits and never splits a TPM 429',()=>{
    expect(classifyAiHttp(502,JSON.stringify({code:429,message:'token limit exceeded'})).kind).toBe('rate');
    expect(classifyAiHttp(429,'token limit exceeded').kind).toBe('rate');
    expect(classifyAiHttp(502,JSON.stringify({error:{status:401}})).kind).toBe('auth');
  });
  it('parses both Retry-After formats',()=>{
    expect(retryAfter(new Headers({'Retry-After':'30'}),1000)).toBe(31000);
    expect(retryAfter(new Headers({'Retry-After':'Thu, 01 Jan 1970 00:01:00 GMT'}),0)).toBe(60000);
  });
  it.each([[401,'','auth'],[403,'openai_error','permission'],[429,'insufficient_quota','quota'],[429,'busy','rate'],[404,'','missing_model'],[413,'','length'],[504,'','network'],[400,'content_filter','refusal']])('classifies %s safely', (status,body,kind)=>{
    const error=classifyAiHttp(Number(status),String(body)+' private-key');expect(error.kind).toBe(kind);expect(error.message).not.toContain('private-key');
  });
  it('heartbeats do not keep a stalled stream alive',async()=>{
    vi.useFakeTimers();let timer:ReturnType<typeof setInterval>;
    const response=new Response(new ReadableStream({start(controller){timer=setInterval(()=>controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')),10);},cancel(){clearInterval(timer);}}));
    const result=readOpenAiStream(response,1000,{idleMs:50});const assertion=expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(51);await assertion;
  });
});
