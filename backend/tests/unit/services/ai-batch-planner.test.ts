import {describe,expect,it} from 'vitest';
import {planAiBatch,type AiBatchSample} from '../../../src/services/ai-batch-planner.js';
import {validateAiConfig,type IAiProviderConfig} from '../../../src/services/ai-provider-config.js';

const config:IAiProviderConfig={providers:[{id:'p',baseUrl:'https://p.test/v1',apiKey:'test',models:[{id:'m',limits:{contextTokens:128000}}]}],batching:{}};
const news=(count:number,chars=120)=>Array.from({length:count},(_,i)=>({id:String(i),title:'新闻',content:'银'.repeat(chars),source:'test',publishedAt:new Date('2026-09-07T08:00:00Z')}));
describe('token and latency aware batch planner',()=>{
  it('packs short news beyond the previous five-item ceiling without filling all 128k tokens',()=>{
    const plan=planAiBatch(news(548),config);
    expect(plan.count).toBe(12);expect(plan.reason).toBe('output');
    expect(plan.inputTokens+plan.outputBudget).toBeLessThan(128000);
    expect(plan.outputTokens).toBeLessThanOrEqual(plan.outputBudget*0.8);
  });
  it('limits Chinese input conservatively without truncation',()=>{
    const items=news(10,20000);const plan=planAiBatch(items,config);
    expect(plan.count).toBe(1);expect(items[0].content.length).toBe(20000);
  });
  it('grows for fast sparse outputs and shrinks for slow dense outputs',()=>{
    const samples=(latencyMs:number,outputTokens:number):AiBatchSample[]=>Array.from({length:3},()=>({newsCount:12,inputTokens:8000,latencyMs,outputTokens}));
    const fast=planAiBatch(news(100),config,samples(30000,1200));
    const slow=planAiBatch(news(100),config,samples(170000,15000));
    expect(fast.count).toBeGreaterThan(12);expect(slow.count).toBeLessThan(12);
  });
  it('respects explicit model output and legacy batch caps',()=>{
    const limited={...config,providers:[{...config.providers[0],models:[{id:'m',parameters:{max_completion_tokens:2048},limits:{contextTokens:128000}}]}]};
    expect(planAiBatch(news(50),limited).outputBudget).toBe(2048);
    expect(planAiBatch(news(50),limited).count).toBe(3);
    expect(planAiBatch(news(50),{...config,scheduling:{maxBatchSize:2}}).count).toBe(2);
  });
  it('covers every input exactly once when preparing a manifest',()=>{
    const items=news(548);const ids:string[]=[];let batches=0;
    while(ids.length<items.length){const remaining=items.slice(ids.length);const plan=planAiBatch(remaining,config);ids.push(...remaining.slice(0,plan.count).map(x=>x.id));batches++;}
    expect(ids).toEqual(items.map(x=>x.id));expect(batches).toBe(46);
  });
  it('rejects invalid budget settings',()=>{
    expect(()=>validateAiConfig({...config,batching:{outputTokens:0}})).toThrow('batching');
    expect(()=>validateAiConfig({...config,batching:{targetInputTokens:20000,maxInputTokens:10000}})).toThrow('exceeds');
  });
});
