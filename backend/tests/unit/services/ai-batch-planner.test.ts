import {describe,expect,it} from 'vitest';
import {
  AI_DEFAULT_LATENCY_MS,
  AI_MAX_REQUEST_CHARS,
  aiLengthBucket,
  estimateAiTokens,
  planAiBatch,
  planAiBatchSplit,
  selectAiProbeTarget,
  type AiBatchSample,
  type AiModelHealth,
} from '../../../src/services/ai-batch-planner.js';
import {validateAiConfig,type IAiProviderConfig} from '../../../src/services/ai-provider-config.js';

const NOW=new Date('2026-09-10T08:00:00Z').getTime();
const config:IAiProviderConfig={providers:[{id:'p',baseUrl:'https://p.test/v1',apiKey:'test',models:[{id:'m',limits:{contextTokens:128000}}]}],batching:{}};
const twoModels:IAiProviderConfig={providers:[{id:'p',baseUrl:'https://p.test/v1',apiKey:'test',models:[{id:'a',limits:{contextTokens:128000}},{id:'b',limits:{contextTokens:128000}}]}],batching:{}};

interface News { id:string; title:string; content:string; source:string; publishedAt:Date; }

const news=(count:number,chars=120,options:{prefix?:string;publishedAt?:Date;stepMs?:number;fill?:string}={}):News[]=>{
  const start=(options.publishedAt ?? new Date('2026-09-10T07:59:00Z')).getTime();
  const step=options.stepMs ?? 60000;
  const fill=options.fill ?? '银';
  return Array.from({length:count},(_unused,index)=>({
    id:`${options.prefix ?? 'n'}-${index+1}`,
    title:'新闻',
    content:fill.repeat(chars),
    source:'test',
    publishedAt:new Date(start+index*step),
  }));
};
const one=(id:string,chars:number,fillChar:string,publishedAt:number):News=>({id,title:'新闻',content:fillChar.repeat(chars),source:'test',publishedAt:new Date(publishedAt)});
const serialized=(item:News):string=>JSON.stringify({newsId:item.id,title:item.title,content:item.content,source:item.source},null,2);
const lengthBucketOf=(item:News):number=>aiLengthBucket(estimateAiTokens(serialized(item))+16);

describe('token and latency aware batch planner',()=>{
  it('buckets by token length and returns a stable prefix of a single bucket',()=>{
    const items:News[]=[];
    for(let index=0;index<20;index++)items.push(one(`s-${index}`,40,'a',NOW-150000+index*1000));
    for(let index=0;index<20;index++)items.push(one(`l-${index}`,3000,'a',NOW-80000+index*1000));
    const plan=planAiBatch(items,config,[],{now:NOW});
    expect(plan.count).toBeGreaterThan(0);
    expect(new Set(plan.newsIds.map(id=>lengthBucketOf(items.find(item=>item.id===id)!))).size).toBe(1);
    const bucket=lengthBucketOf(items.find(item=>item.id===plan.newsIds[0]!)!);
    const inBucket=items.filter(item=>lengthBucketOf(item)===bucket)
      .sort((a,b)=>a.publishedAt.getTime()-b.publishedAt.getTime()||(a.id<b.id?-1:a.id>b.id?1:0));
    expect(plan.newsIds).toEqual(inBucket.slice(0,plan.count).map(item=>item.id));
    expect(plan.newsIds.length).toBe(plan.count);
  });

  it('is deterministic and independent of the input order',()=>{
    const items:News[]=[];
    for(let index=0;index<10;index++)items.push(one(`s-${index}`,40,'a',NOW-120000+index*1000));
    for(let index=0;index<10;index++)items.push(one(`l-${index}`,3000,'a',NOW-60000+index*1000));
    const first=planAiBatch(items,config,[],{now:NOW});
    expect(planAiBatch(items,config,[],{now:NOW})).toEqual(first);
    expect(planAiBatch([...items].reverse(),config,[],{now:NOW})).toEqual(first);
  });

  it('prioritises the bucket containing a news waiting longer than three minutes',()=>{
    const fresh=Array.from({length:20},(_unused,index)=>one(`f-${index}`,40,'a',NOW-60000+index*1000));
    const stale=[one('old-1',3000,'a',NOW-5*60*1000),one('old-2',3000,'a',NOW-4*60*1000)];
    const plan=planAiBatch([...fresh,...stale],config,[],{now:NOW});
    expect(plan.starvationOverride).toBe(true);
    expect(plan.newsIds).toContain('old-1');
    expect(plan.newsIds.every(id=>id.startsWith('old'))).toBe(true);
  });

  it('computes output as (256 + n × single output) × 1.25',()=>{
    const items=news(10,60);
    const cold=planAiBatch(items,config,[],{now:NOW});
    expect(cold.singleOutputTokens).toBe(512);
    expect(cold.outputTokens).toBe(Math.ceil((256+cold.count*512)*1.25));
    const samples:AiBatchSample[]=Array.from({length:5},()=>({providerId:'p',model:'m',newsCount:2,inputTokens:900,outputTokens:200,latencyMs:5000}));
    const warm=planAiBatch(items,config,samples,{now:NOW});
    expect(warm.singleOutputTokens).toBe(100);
    expect(warm.outputTokens).toBe(Math.ceil((256+warm.count*100)*1.25));
  });

  it('isolates observations by provider, model, extraction version and batch-size bucket',()=>{
    const items=news(10,60);
    const foreign:AiBatchSample[]=[{providerId:'other',model:'m',newsCount:2,inputTokens:1,outputTokens:1,latencyMs:1,firstContentMs:10}];
    expect(planAiBatch(items,config,foreign,{now:NOW}).coldStart).toBe(true);
    const wrongVersion:AiBatchSample[]=[{providerId:'p',model:'m',newsCount:2,inputTokens:1,outputTokens:1,latencyMs:1,extractionVersion:'v2'}];
    expect(planAiBatch(items,config,wrongVersion,{now:NOW,extractionVersion:'v1'}).coldStart).toBe(true);
    const bigBucket:AiBatchSample[]=Array.from({length:6},()=>({providerId:'p',model:'m',newsCount:40,inputTokens:1,outputTokens:40,latencyMs:180000,firstContentMs:1000}));
    const plan=planAiBatch(items,config,bigBucket,{now:NOW});
    expect(plan.singleOutputTokens).toBe(512);
    expect(plan.predictedLatencyMs).toBe(AI_DEFAULT_LATENCY_MS);
  });

  it('calibrates input estimates with P90 × 1.2 once five usage samples exist',()=>{
    const items=[one('a',100,'a',NOW-3000),one('b',100,'a',NOW-2000),one('c',100,'a',NOW-1000)];
    const rawEach=estimateAiTokens(serialized(items[0]!))+16;
    const four:AiBatchSample[]=Array.from({length:4},()=>({providerId:'p',model:'m',newsCount:1,inputTokens:Math.round(rawEach*0.5),outputTokens:10,latencyMs:1000,inputRatio:0.5}));
    const five:AiBatchSample[]=Array.from({length:5},()=>({providerId:'p',model:'m',newsCount:1,inputTokens:Math.round(rawEach*0.5),outputTokens:10,latencyMs:1000,inputRatio:0.5}));
    const uncalibrated=planAiBatch(items,config,four,{now:NOW});
    expect(uncalibrated.inputTokens).toBe(2048+uncalibrated.count*rawEach);
    const calibrated=planAiBatch(items,config,five,{now:NOW});
    expect(calibrated.count).toBe(uncalibrated.count);
    expect(calibrated.inputTokens).toBe(2048+calibrated.count*Math.ceil(rawEach*0.5*1.2));
  });

  it('predicts latency as first-content P80 plus output over speed P20, defaulting to 90s',()=>{
    const items=news(6,60);
    expect(planAiBatch(items,config,[],{now:NOW}).predictedLatencyMs).toBe(AI_DEFAULT_LATENCY_MS);
    const samples:AiBatchSample[]=Array.from({length:5},()=>({providerId:'p',model:'m',newsCount:2,inputTokens:900,outputTokens:200,latencyMs:3000,firstContentMs:1000}));
    const warm=planAiBatch(items,config,samples,{now:NOW});
    expect(warm.predictedLatencyMs).toBe(Math.ceil(1000+warm.outputTokens/100*1000));
  });

  it('uses (legal + 2) / (valid attempts + 3) and excludes cancelled or waiting calls',()=>{
    const items=news(4,60);
    const samples:AiBatchSample[]=[
      ...Array.from({length:3},():AiBatchSample=>({providerId:'p',model:'m',newsCount:1,inputTokens:100,outputTokens:10,latencyMs:1000,outcome:'success'})),
      {providerId:'p',model:'m',newsCount:1,inputTokens:100,outputTokens:0,latencyMs:1000,outcome:'length'},
      {providerId:'p',model:'m',newsCount:1,inputTokens:100,outputTokens:0,latencyMs:1000,outcome:'cancelled'},
      {providerId:'p',model:'m',newsCount:1,inputTokens:100,outputTokens:0,latencyMs:1000,outcome:'wait'},
    ];
    expect(planAiBatch(items,config,samples,{now:NOW}).legalCompletionRate).toBeCloseTo(5/7,10);
  });

  it('selects by news × completion rate / (wait + request time), ties by completion then order',()=>{
    const items=news(10,60);
    const health:AiModelHealth[]=[{providerId:'p',model:'a',lastServedAt:0,waitMs:10_000_000},{providerId:'p',model:'b',lastServedAt:0,waitMs:0}];
    expect(planAiBatch(items,twoModels,[],{now:NOW,health}).model).toBe('b');
    expect(planAiBatch(items,twoModels,[],{now:NOW}).model).toBe('a');
  });

  it('caps growth at +25% of the last successful batch and keeps cold start free of history limits',()=>{
    const samples:AiBatchSample[]=Array.from({length:5},()=>({providerId:'p',model:'m',newsCount:10,inputTokens:500,outputTokens:10,latencyMs:1000}));
    const warm=planAiBatch(news(100,60),config,samples,{now:NOW});
    expect(warm.count).toBe(13);
    expect(warm.reason).toBe('growth');

    // 冷启动不受**历史**批量（3–5 条）限制：没有初始批量配置时，一次可容纳到聚合上限。
    const unbounded=planAiBatch(news(100,60),{...config,scheduling:{maxBatchSize:64}},[],{now:NOW});
    expect(unbounded.coldStart).toBe(true);
    expect(unbounded.count).toBeGreaterThan(3);

    // 但运维显式配置的 initialBatchSize 必须被尊重——它的用途正是「先用小批量探活」。
    const bounded=planAiBatch(news(100,60),{...config,scheduling:{initialBatchSize:3,maxBatchSize:64}},[],{now:NOW});
    expect(bounded.coldStart).toBe(true);
    expect(bounded.count).toBe(3);
  });

  it('splits length and truncation, double structure failures, but never HTTP 429',()=>{
    expect(planAiBatchSplit({count:10,outcome:'length'})).toEqual({split:true,nextCount:5,reason:'length'});
    expect(planAiBatchSplit({count:10,outcome:'truncation'})).toEqual({split:true,nextCount:5,reason:'truncation'});
    expect(planAiBatchSplit({count:10,outcome:'structure',consecutiveStructureFailures:1}).split).toBe(false);
    expect(planAiBatchSplit({count:10,outcome:'structure',consecutiveStructureFailures:2})).toEqual({split:true,nextCount:5,reason:'structure'});
    expect(planAiBatchSplit({count:10,outcome:'rate_limit'})).toEqual({split:false,nextCount:10,reason:'rate_limit'});
    expect(planAiBatchSplit({count:1,outcome:'length'}).split).toBe(false);
  });

  it('probes the least-recently-served healthy model every ten successful claims',()=>{
    const health:AiModelHealth[]=[{providerId:'p',model:'a',lastServedAt:500},{providerId:'p',model:'b',lastServedAt:100},{providerId:'p',model:'c',healthy:false,lastServedAt:0}];
    expect(selectAiProbeTarget(health,10)).toEqual({providerId:'p',model:'b'});
    expect(selectAiProbeTarget(health,9)).toBeUndefined();
    expect(selectAiProbeTarget(health,0)).toBeUndefined();
    const items=news(10,60);
    expect(planAiBatch(items,twoModels,[],{now:NOW}).model).toBe('a');
    expect(planAiBatch(items,twoModels,[],{now:NOW,health,successfulClaims:10}).model).toBe('b');
  });

  it('never returns a plan that exceeds the model context and explains the reject',()=>{
    const rejected=planAiBatch([one('h',45000,'银',NOW-1000)],config,[],{now:NOW});
    expect(rejected.count).toBe(0);
    expect(rejected.reason).toBe('context');
    const ok=planAiBatch(news(5,60),config,[],{now:NOW});
    expect(ok.count).toBeGreaterThan(0);
    expect(ok.inputTokens+ok.outputTokens+2048).toBeLessThanOrEqual(128000);
  });

  it('aligns the character ceiling with 240000 and clips oversized serialized input',()=>{
    expect(AI_MAX_REQUEST_CHARS).toBe(240000);
    const bigContext:IAiProviderConfig={providers:[{id:'p',baseUrl:'https://p.test/v1',apiKey:'test',models:[{id:'m',limits:{contextTokens:2_000_000},parameters:{max_completion_tokens:8192}}]}],batching:{targetInputTokens:1_000_000,maxInputTokens:1_000_000}};
    const items=[one('a',100000,'a',NOW-3000),one('b',100000,'a',NOW-2000),one('c',100000,'a',NOW-1000)];
    const plan=planAiBatch(items,bigContext,[],{now:NOW});
    expect(plan.reason).toBe('chars');
    expect(plan.count).toBe(2);
    expect(plan.inputChars).toBeLessThanOrEqual(AI_MAX_REQUEST_CHARS);
  });

  it('respects explicit model output caps and legacy batch caps',()=>{
    const limited={...config,providers:[{...config.providers[0]!,models:[{id:'m',parameters:{max_completion_tokens:2048},limits:{contextTokens:128000}}]}]};
    const plan=planAiBatch(news(50,60),limited,[],{now:NOW});
    expect(plan.outputBudget).toBe(2048);
    expect(plan.outputTokens).toBeLessThanOrEqual(2048);
    expect(plan.count).toBe(2);
    expect(planAiBatch(news(50,60),{...config,scheduling:{maxBatchSize:2}}).count).toBe(2);
  });

  it('covers every input exactly once when preparing a manifest',()=>{
    const items=news(548,60);
    const ids:string[]=[];let guard=0;
    while(ids.length<items.length&&guard++<2000){
      const remaining=items.filter(item=>!ids.includes(item.id));
      const plan=planAiBatch(remaining,config,[],{now:NOW});
      if(plan.count===0)break;
      ids.push(...plan.newsIds);
    }
    expect(ids.length).toBe(items.length);
    expect(new Set(ids).size).toBe(items.length);
  });

  it('rejects invalid budget settings',()=>{
    expect(()=>validateAiConfig({...config,batching:{outputTokens:0}})).toThrow('batching');
    expect(()=>validateAiConfig({...config,batching:{targetInputTokens:20000,maxInputTokens:10000}})).toThrow('exceeds');
  });
});
