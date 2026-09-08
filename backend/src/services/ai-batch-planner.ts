import type {IAiProviderConfig} from './ai-provider-config.js';
import type {ICausalSignalExtractionNews} from './causal-signal-extraction-service.js';

export interface AiBatchSample {
  providerId?:string;
  model?:string;
  newsCount:number;
  inputTokens:number;
  outputTokens:number;
  latencyMs:number;
}
export interface AiBatchPlan {
  providerId?:string;
  model?:string;
  count:number;
  inputTokens:number;
  outputTokens:number;
  outputBudget:number;
  targetInputTokens:number;
  reason:'input'|'output'|'count'|'end';
}
const quantile=(values:number[],fraction:number):number=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*fraction))] ?? 0;

/** Conservative UTF-8 token bound; never assumes different vendors share a tokenizer. */
export const estimateAiTokens=(value:string):number=>Buffer.byteLength(value,'utf8');

export function planAiBatch(news:readonly ICausalSignalExtractionNews[],config:IAiProviderConfig,samples:readonly AiBatchSample[]=[]):AiBatchPlan {
  const options=config.batching ?? {};
  const models=config.providers.flatMap(provider=>provider.models.map(model=>({provider,model})));
  if(models.length>1) {
    const plans=models.map(({provider,model})=>{
      const observations=samples.filter(sample=>sample.providerId===provider.id && sample.model===model.id);
      const plan=planAiBatch(news,{...config,providers:[{...provider,models:[model]}]},observations);
      const latency=quantile(observations.map(sample=>sample.latencyMs),0.8) || options.targetLatencyMs || 90000;
      return {plan,throughput:plan.count/latency};
    });
    plans.sort((a,b)=>b.throughput-a.throughput || b.plan.count-a.plan.count);
    return plans[0]!.plan;
  }
  const outputBudget=Math.min(options.outputTokens ?? 8192,...models.map(({model})=>model.parameters?.max_completion_tokens ?? model.parameters?.max_tokens ?? Infinity));
  const context=Math.min(...models.map(({provider,model})=>Math.min(provider.limits?.contextTokens ?? Infinity,model.limits?.contextTokens ?? 128000)));
  const usable=samples.filter(sample=>sample.newsCount>0 && sample.latencyMs>0).slice(-20);
  const targetLatency=options.targetLatencyMs ?? 90000;
  // Successful per-call latency excludes queue/cooldown time. Grow gradually only after observations.
  const latency=quantile(usable.map(sample=>sample.latencyMs),0.8);
  const factor=usable.length>=3?Math.max(0.5,Math.min(2,targetLatency/Math.max(1,latency))):1;
  const target=Math.max(1,Math.min(options.maxInputTokens ?? 64000,(options.targetInputTokens ?? 16000)*factor,context-outputBudget-2048));
  // Use the upper output-per-news quantile with headroom; dense extraction shrinks future batches.
  const observed=quantile(usable.map(sample=>sample.outputTokens/sample.newsCount),0.9);
  const perNews=Math.max(128,observed?Math.ceil(observed*1.5):(options.estimatedOutputTokensPerNews ?? 512));
  const maximum=Math.min(options.maxNews ?? 64,config.scheduling?.maxBatchSize ?? Infinity,config.batching?Infinity:config.scheduling?.initialBatchSize ?? Infinity);
  const latencyCount=usable.length>=3?Math.max(1,Math.floor(quantile(usable.map(sample=>sample.newsCount),0.8)*factor)):Infinity;
  let count=0;let inputTokens=2048;let chars=2048;let reason:AiBatchPlan['reason']='end';
  for(const item of news) {
    const serialized=JSON.stringify({newsId:item.id,title:item.title,content:item.content,source:item.source},null,2);
    const tokens=estimateAiTokens(serialized)+16;
    if(count>0) {
      if(count>=maximum || count>=latencyCount){reason='count';break;}
      if(inputTokens+tokens>target || chars+serialized.length+16>220000){reason='input';break;}
      if((count+1)*perNews>outputBudget*0.8){reason='output';break;}
    }
    count++;inputTokens+=tokens;chars+=serialized.length+16;
  }
  // Keep an oversized singleton intact: the exact request guard will explain the failure.
  return {count,inputTokens,outputTokens:count*perNews,outputBudget,targetInputTokens:Math.floor(target),reason,providerId:models[0]?.provider.id,model:models[0]?.model.id};
}
