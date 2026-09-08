import {afterEach,describe,expect,it,vi} from 'vitest';
import {performAiRequest} from '../../../src/services/ai-transport.js';
import {AiAdaptiveScheduler,type AiCandidate} from '../../../src/services/ai-adaptive-scheduler.js';
import {MemoryAiSchedulerStore} from '../../../src/services/ai-scheduler-store.js';
import {AiCallFailure,AiPausedError} from '../../../src/services/ai-scheduling-errors.js';

const candidate:AiCandidate={provider:{id:'p',apiKey:'private',baseUrl:'https://example.invalid/v1',models:[{id:'m'}]},model:{id:'m',parameters:{stream:true},timeouts:{firstResponseMs:45,idleMs:45,totalMs:180}},serialized:'{}'};
afterEach(()=>vi.useRealTimers());
describe('scheduled AI transport deadlines',()=>{
  it('cancels an upstream that never sends response headers',async()=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    const fetcher=vi.fn((_url,init)=>{signal=init?.signal;return new Promise<Response>(()=>{});});
    const result=performAiRequest(candidate,fetcher as typeof fetch,x=>x,{});
    const assertion=expect(result).rejects.toBeInstanceOf(AiCallFailure);
    await vi.advanceTimersByTimeAsync(46);await assertion;expect(signal?.aborted).toBe(true);
  });
  it('propagates a run deadline to the request and releases its concurrency lease',async()=>{
    vi.useFakeTimers();let signal:AbortSignal|undefined;
    const config={providers:[candidate.provider],scheduling:{runTimeoutMs:20}};
    const store=new MemoryAiSchedulerStore();const scheduler=new AiAdaptiveScheduler(config,store);
    const fetcher=vi.fn((_url,init)=>{signal=init?.signal;return new Promise<Response>(()=>{});});
    const result=scheduler.execute([candidate],(c,metrics,abort)=>performAiRequest(c,fetcher as typeof fetch,x=>x,metrics,abort));
    const assertion=expect(result).rejects.toBeInstanceOf(AiPausedError);
    await vi.advanceTimersByTimeAsync(21);await assertion;
    expect(signal?.aborted).toBe(true);expect(store.snapshot.leases).toHaveLength(0);
    expect(store.attempts[0].status).toBe('CANCELLED');
  });
  it('rejects malformed JSON only after a complete stream',async()=>{
    const body='data: '+JSON.stringify({choices:[{index:0,delta:{content:'{bad json'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
    await expect(performAiRequest(candidate,vi.fn(async()=>new Response(body)) as typeof fetch,x=>x,{})).rejects.toMatchObject({kind:'structure'});
  });
});
