import { describe, expect, it, vi } from 'vitest';
import { TraceManager } from '../../../src/services/trace-manager.js';
import { checkpointWork, inputFingerprint } from '../../../src/services/pipeline-checkpoint.js';
import { dailyCloseVisibleAt, visibleYields } from '../../../src/services/yield-visibility.js';
import { aiConfigFingerprint } from '../../../src/services/ai-provider-config.js';
import { planAiBatch } from '../../../src/services/ai-batch-planner.js';

describe('pipeline consistency', () => {
  it('rejects changes to an existing trace time before changing its status', async () => {
    const upsert = vi.fn();
    const db = { runTrace: {findUnique:async()=>({clusterKey:'g',kind:'BACKTEST',asOf:new Date('2026-09-01')}),upsert} };
    await expect(TraceManager.startRunTrace(db,'t','g','BACKTEST',new Date('2026-09-02'))).rejects.toThrow('immutable');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('restores saved preparation without fetching again and rejects changed inputs', async () => {
    const rows: any[]=[];
    const db = {$queryRawUnsafe:async()=>rows,$executeRawUnsafe:async(_sql:string,_trace:string,_stage:string,input:string,result:string)=>{rows.push({input,result:JSON.parse(result)});}};
    const work=vi.fn(async()=>({articles:['a']}));
    await checkpointWork(db,'t','news',{version:1},work);
    expect(await checkpointWork(db,'t','news',{version:1},work)).toEqual({articles:['a']});
    expect(work).toHaveBeenCalledTimes(1);
    await expect(checkpointWork(db,'t','news',{version:2},work)).rejects.toThrow('input changed');
  });

  it('does not let D+5 losses leak into a D+1 historical penalty', () => {
    const row={yield1Day:0.02,yield1DayVisibleAt:new Date('2026-09-08T07:00Z'),yield5Day:-0.2,yield5DayVisibleAt:new Date('2026-09-14T07:00Z')};
    expect(visibleYields(row,new Date('2026-09-08T06:59Z'))).toEqual([]);
    expect(visibleYields(row,new Date('2026-09-08T08:00Z'))).toEqual([0.02]);
    expect(visibleYields(row,new Date('2026-09-14T08:00Z'))).toEqual([0.02,-0.2]);
    expect(visibleYields({yield1Day:-0.2},new Date('2026-09-14'))).toEqual([]);
    expect(dailyCloseVisibleAt(new Date('2026-09-08T00:00Z')).toISOString()).toBe('2026-09-08T07:00:00.000Z');
  });

  it('keeps extraction identity across operational changes but invalidates semantic changes', () => {
    const config={providers:[{id:'p',baseUrl:'https://p.test',apiKey:'test',models:[{id:'m',parameters:{temperature:0}}]}]};
    const operational={...config,scheduling:{globalConcurrency:5},providers:[{...config.providers[0],apiKey:'rotated',limits:{initialConcurrency:3},models:[{...config.providers[0].models[0],timeoutMs:90000}]}]};
    expect(aiConfigFingerprint(operational)).toBe(aiConfigFingerprint(config));
    expect(aiConfigFingerprint({...config,providers:[{...config.providers[0],baseUrl:'https://another.test'}]})).not.toBe(aiConfigFingerprint(config));
    expect(inputFingerprint({a:1,b:2})).toBe(inputFingerprint({b:2,a:1}));
  });

  it('uses a large model capacity without averaging unrelated model samples', () => {
    const news=Array.from({length:50},(_,i)=>({id:String(i),title:'news',content:'x'.repeat(1500),source:'test',publishedAt:new Date('2026-09-07')}));
    const config={batching:{targetInputTokens:64000,maxInputTokens:64000,outputTokens:8192},providers:[{id:'p',baseUrl:'https://p.test',apiKey:'test',models:[{id:'small',limits:{contextTokens:6000},parameters:{max_tokens:1024}},{id:'large',limits:{contextTokens:128000}}]}]};
    const plan=planAiBatch(news,config,[{providerId:'p',model:'small',newsCount:1,inputTokens:4000,outputTokens:1000,latencyMs:170000}]);
    expect(plan.model).toBe('large');
    expect(plan.count).toBeGreaterThan(planAiBatch(news,{...config,providers:[{...config.providers[0],models:[config.providers[0].models[0]]}]}).count);
    expect(plan.inputTokens+plan.outputBudget).toBeLessThan(128000);
  });
});
