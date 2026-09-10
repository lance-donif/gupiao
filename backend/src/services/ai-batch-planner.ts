import type {IAiProvider,IAiProviderConfig} from './ai-provider-config.js';
import type {ICausalSignalExtractionNews} from './causal-signal-extraction-service.js';

/** 最终 LLM 请求体（含 prompt 与序列化 body）的硬字符上限，与 ai-chat-client.ts 的 240000 对齐。 */
export const AI_MAX_REQUEST_CHARS=240000;
/** 输入 + 输出之外固定预留的安全余量（tokens）。 */
export const AI_CONTEXT_SAFETY_TOKENS=2048;
/** 模型未显式声明上下文窗口时的默认值。 */
export const AI_DEFAULT_CONTEXT_TOKENS=128000;
/** prompt 模板固定占用的 tokens 估算下界。 */
export const AI_PROMPT_OVERHEAD_TOKENS=2048;
/** prompt 模板固定占用的字符估算下界。 */
export const AI_PROMPT_OVERHEAD_CHARS=2048;
/** 冷启动（无成功观测）时单条新闻的输出估计。 */
export const AI_COLD_SINGLE_OUTPUT_TOKENS=512;
/** 输出预估基值；输出预估 = (基值 + 新闻数 × 单条估计) × 余量。 */
export const AI_OUTPUT_BASE_TOKENS=256;
/** 输出预估余量系数。 */
export const AI_OUTPUT_MARGIN=1.25;
/** 输入估计校准所需的最少真实 usage 观测数。 */
export const AI_INPUT_CALIBRATION_MIN_USAGE=5;
/** 输入校准系数：观测比例 P90 × 该余量。 */
export const AI_INPUT_CALIBRATION_MARGIN=1.2;
/** 观测窗口时长。 */
export const AI_OBSERVATION_WINDOW_MS=7*24*60*60*1000;
/** 每个隔离维度最多保留的观测次数。 */
export const AI_MAX_OBSERVATIONS=50;
/** 防饥饿阈值：新闻等待超过该时长即优先其所在长度桶。 */
export const AI_STARVATION_WAIT_MS=3*60*1000;
/** 单批新闻数硬上限。 */
export const AI_MAX_NEWS_PER_BATCH=64;
/** 相对最近一次成功批量的单次增长上限。 */
export const AI_BATCH_GROWTH_FACTOR=1.25;
/** 观测不足时缺省的请求耗时。 */
export const AI_DEFAULT_LATENCY_MS=90000;
/** 每多少次成功领取允许一次健康模型探测。 */
export const AI_PROBE_INTERVAL=10;

/** 批次结果分类；缺省视为成功。`cancelled`/`wait` 不计入有效尝试。 */
export type AiBatchOutcome='success'|'length'|'truncation'|'structure'|'rate_limit'|'cancelled'|'wait'|'other';

export interface AiBatchSample {
  providerId?:string;
  model?:string;
  newsCount:number;
  inputTokens:number;
  outputTokens:number;
  latencyMs:number;
  /** 抽取版本；与规划入参不一致的观测不参与统计。 */
  extractionVersion?:string;
  /** 观测时间；缺省视为落在窗口内。 */
  observedAt?:number|Date;
  /** 结果分类；缺省视为成功。 */
  outcome?:AiBatchOutcome;
  /** 首个有效内容耗时（ms）。 */
  firstContentMs?:number;
  /** 取得真实 usage 时对同一批次的字节上界估计，用于推导观测比例。 */
  byteBoundInputTokens?:number;
  /** 观测比例 inputTokens / 字节上界；优先于 byteBoundInputTokens。 */
  inputRatio?:number;
  /** 生成速度（tokens/秒）；缺省时按 (latencyMs - firstContentMs) 推算。 */
  tokensPerSecond?:number;
}

export type AiBatchPlanReason='input'|'output'|'count'|'end'|'context'|'chars'|'growth';

export interface AiBatchPlan {
  providerId?:string;
  model?:string;
  count:number;
  inputTokens:number;
  outputTokens:number;
  outputBudget:number;
  targetInputTokens:number;
  reason:AiBatchPlanReason;
  /** 本次计划实际选中的新闻 ID（稳定前缀），供调用方显式选取。 */
  newsIds:string[];
  /** 估算的输入 prompt 与序列化 body 字符数（含固定开销）。 */
  inputChars:number;
  /** 本次批次使用的单条输出估计。 */
  singleOutputTokens:number;
  /** (合法完成 + 2) / (有效尝试 + 3)。 */
  legalCompletionRate:number;
  /** 预计排队等待时长。 */
  predictedWaitMs:number;
  /** 预计请求耗时。 */
  predictedLatencyMs:number;
  /** 预计就绪时间（epoch ms）。 */
  predictedCompletionAt:number;
  /** 是否处于该模型的冷启动（窗口内无成功观测）。 */
  coldStart:boolean;
  /** 本次是否由防饥饿规则覆盖常规选择。 */
  starvationOverride:boolean;
}

export interface AiModelHealth {
  providerId:string;
  model:string;
  /** 缺省视为健康。 */
  healthy?:boolean;
  /** 最近一次被服务的时间戳（epoch ms）；缺省视为从未服务（最该被探测）。 */
  lastServedAt?:number;
  /** 预计排队等待时长。 */
  waitMs?:number;
}

export interface AiBatchPlanOptions {
  /** 当前时间；必须由调用方传入以保证纯函数可测。 */
  now?:number;
  /** 抽取版本，用于观测四维隔离。 */
  extractionVersion?:string;
  /** 模型健康统计快照。 */
  health?:readonly AiModelHealth[];
  /** 累计成功领取次数；每 AI_PROBE_INTERVAL 次触发一次健康模型探测。 */
  successfulClaims?:number;
  /** 强制本次进行健康模型探测。 */
  probe?:boolean;
}

export interface AiBatchSplitInput {
  count:number;
  outcome?:AiBatchOutcome;
  consecutiveStructureFailures?:number;
}
export interface AiBatchSplitDecision {
  split:boolean;
  nextCount:number;
  reason:'length'|'truncation'|'structure'|'rate_limit'|'none';
}

const quantile=(values:readonly number[],fraction:number):number=>{
  if(values.length===0)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*fraction))] ?? 0;
};

/** Conservative UTF-8 token bound; never assumes different vendors share a tokenizer. */
export const estimateAiTokens=(value:string):number=>Buffer.byteLength(value,'utf8');

/** 按 token 长度分桶：桶边界为 2 的幂（256 / 512 / …），保证同批长度同质。 */
export const aiLengthBucket=(tokens:number):number=>{
  let bucket=0;
  let limit=256;
  while(tokens>limit&&bucket<12){limit*=2;bucket++;}
  return bucket;
};

/** 观测隔离用的批次大小区间：1–4 / 5–8 / 9–16 / 17–32 / 33+。 */
export const aiBatchSizeBucket=(count:number):number=>{
  if(count<=4)return 0;
  if(count<=8)return 1;
  if(count<=16)return 2;
  if(count<=32)return 3;
  return 4;
};

/** 输出预估：256 + 新闻数 × 单条估计，再乘 1.25 余量。 */
const expectedOutputTokens=(count:number,perNews:number):number=>Math.ceil((AI_OUTPUT_BASE_TOKENS+count*perNews)*AI_OUTPUT_MARGIN);

const serializeNews=(item:ICausalSignalExtractionNews):string=>JSON.stringify({newsId:item.id,title:item.title,content:item.content,source:item.source},null,2);

const successOutcome=(outcome?:AiBatchOutcome):boolean=>outcome===undefined||outcome==='success';
const validAttempt=(outcome?:AiBatchOutcome):boolean=>outcome!=='cancelled'&&outcome!=='wait';

const isWithinWindow=(observedAt:number|Date|undefined,now:number):boolean=>{
  if(observedAt===undefined)return true;
  const at=observedAt instanceof Date?observedAt.getTime():observedAt;
  return Number.isFinite(at)&&at<=now&&now-at<=AI_OBSERVATION_WINDOW_MS;
};

const sampleSpeed=(sample:AiBatchSample):number|undefined=>{
  if(typeof sample.tokensPerSecond==='number'&&Number.isFinite(sample.tokensPerSecond)&&sample.tokensPerSecond>0)return sample.tokensPerSecond;
  if(typeof sample.firstContentMs!=='number'||!Number.isFinite(sample.firstContentMs))return undefined;
  if(!(sample.outputTokens>0))return undefined;
  const generationMs=Math.max(1,sample.latencyMs-sample.firstContentMs);
  return sample.outputTokens/(generationMs/1000);
};

const toInputRatio=(sample:AiBatchSample):number|undefined=>{
  if(typeof sample.inputRatio==='number'&&Number.isFinite(sample.inputRatio)&&sample.inputRatio>0)return sample.inputRatio;
  if(typeof sample.byteBoundInputTokens==='number'&&sample.byteBoundInputTokens>0&&Number.isFinite(sample.inputTokens))return sample.inputTokens/sample.byteBoundInputTokens;
  return undefined;
};

interface ScopedStats {
  legalCompletionRate:number;
  singleOutputTokens:number;
  coldStart:boolean;
}
interface ModelStats extends ScopedStats {
  inputMultiplier:number;
  waitMs:number;
  globalLastSuccess:number|undefined;
  predictedLatencyMs:(count:number)=>number;
}

const computeScopedStats=(scoped:readonly AiBatchSample[],coldStart:boolean):ScopedStats=>{
  const attempts=scoped.filter(sample=>validAttempt(sample.outcome));
  const successes=attempts.filter(sample=>successOutcome(sample.outcome));
  const densities=successes.filter(sample=>sample.newsCount>0).map(sample=>sample.outputTokens/sample.newsCount).filter(value=>Number.isFinite(value));
  return {
    legalCompletionRate:(successes.length+2)/(attempts.length+3),
    singleOutputTokens:densities.length?Math.max(1,Math.ceil(quantile(densities,0.9))):AI_COLD_SINGLE_OUTPUT_TOKENS,
    coldStart,
  };
};

const buildModelStats=(windowed:readonly AiBatchSample[],waitMs:number):ModelStats=>{
  const successes=windowed.filter(sample=>successOutcome(sample.outcome));
  const coldStart=successes.length===0;
  const lastSuccess=coldStart?undefined:successes[successes.length-1]!.newsCount;
  const ratios=windowed.map(toInputRatio).filter((value):value is number=>typeof value==='number'&&value>0);
  // 校准比例按“供应商 + 模型 + 抽取版本”观测统计；批次大小隔离作用于下面的 scoped 统计。
  const inputMultiplier=ratios.length>=AI_INPUT_CALIBRATION_MIN_USAGE?Math.max(0.01,quantile(ratios,0.9)*AI_INPUT_CALIBRATION_MARGIN):1;
  // 耗时预测同样按批次大小区间隔离：只使用与目标批次同区间的观测。
  const predictedLatencyMs=(count:number):number=>{
    const scoped=windowed.filter(sample=>aiBatchSizeBucket(sample.newsCount)===aiBatchSizeBucket(count));
    const timed=scoped.filter(sample=>successOutcome(sample.outcome)&&typeof sample.firstContentMs==='number'&&Number.isFinite(sample.firstContentMs)&&sample.newsCount>0);
    const speeds=timed.map(sampleSpeed).filter((value):value is number=>typeof value==='number'&&value>0);
    const firstContentP80=quantile(timed.map(sample=>sample.firstContentMs as number),0.8);
    const speedP20=quantile(speeds,0.2);
    if(scoped.length<AI_INPUT_CALIBRATION_MIN_USAGE||timed.length===0||!(speedP20>0))return AI_DEFAULT_LATENCY_MS;
    const output=expectedOutputTokens(count,computeScopedStats(scoped,coldStart).singleOutputTokens);
    return Math.ceil(firstContentP80+output/Math.max(0.001,speedP20)*1000);
  };
  return {...computeScopedStats(windowed,coldStart),inputMultiplier,waitMs,globalLastSuccess:lastSuccess,predictedLatencyMs};
};

const modelBudgets=(config:IAiProviderConfig,provider:IAiProvider,model:IAiProvider['models'][number])=>{
  const batching=config.batching ?? {};
  const outputBudget=Math.min(batching.outputTokens ?? 8192,model.parameters?.max_completion_tokens ?? model.parameters?.max_tokens ?? Infinity);
  const context=Math.min(provider.limits?.contextTokens ?? Infinity,model.limits?.contextTokens ?? AI_DEFAULT_CONTEXT_TOKENS);
  const targetInput=Math.max(1,Math.min(batching.maxInputTokens ?? 64000,batching.targetInputTokens ?? 16000,context-outputBudget-AI_CONTEXT_SAFETY_TOKENS));
  return {outputBudget,context,targetInput};
};

/**
 * 每 10 次成功领取允许一次健康模型探测：选最久未服务的健康模型处理真实待办。
 * 只做选择，不发任何请求。
 */
export function selectAiProbeTarget(health:readonly AiModelHealth[],successfulClaims:number):{providerId:string;model:string}|undefined {
  if(!Number.isFinite(successfulClaims)||successfulClaims<=0||successfulClaims%AI_PROBE_INTERVAL!==0)return undefined;
  const healthy=health.filter(item=>item.healthy!==false);
  if(healthy.length===0)return undefined;
  const target=healthy.reduce((best,item)=>((item.lastServedAt ?? 0)<(best.lastServedAt ?? 0)?item:best));
  return {providerId:target.providerId,model:target.model};
}

/**
 * 拆分规则：
 * - 长度错误 / 输出截断 → 批量拆半；
 * - 结构错误连续两次 → 拆半；
 * - HTTP 429（rate_limit）→ 不拆批。
 */
export function planAiBatchSplit(input:AiBatchSplitInput):AiBatchSplitDecision {
  const count=Math.max(0,Math.floor(Number.isFinite(input.count)?input.count:0));
  const half=Math.max(1,Math.floor(count/2));
  if(count<=1)return {split:false,nextCount:count,reason:'none'};
  if(input.outcome==='length'||input.outcome==='truncation')return {split:true,nextCount:half,reason:input.outcome};
  if(input.outcome==='structure'&&(input.consecutiveStructureFailures ?? 0)>=2)return {split:true,nextCount:half,reason:'structure'};
  if(input.outcome==='rate_limit')return {split:false,nextCount:count,reason:'rate_limit'};
  return {split:false,nextCount:count,reason:'none'};
}

interface PreparedNews {
  readonly id:string;
  readonly serialized:string;
  readonly rawTokens:number;
  readonly chars:number;
  readonly publishedAt:number;
  readonly lengthBucket:number;
}

interface Candidate {
  readonly plan:AiBatchPlan;
  readonly score:number;
  readonly order:number;
  readonly bucketKey:number;
}

/**
 * 纯函数批次规划器：接收待处理新闻、候选模型、统计快照与当前时间，返回候选计划。
 * 不做数据库操作、不发请求、不读环境变量；当前时间与统计必须由入参传入。
 */
export function planAiBatch(news:readonly ICausalSignalExtractionNews[],config:IAiProviderConfig,samples:readonly AiBatchSample[]=[],options:AiBatchPlanOptions={}):AiBatchPlan {
  const now=options.now ?? Date.now();
  const version=options.extractionVersion ?? '';
  const batching=config.batching ?? {};
  const models=config.providers.flatMap((provider,providerIndex)=>provider.models.map((model,modelIndex)=>({provider,model,order:providerIndex*1000+modelIndex})));
  const first=models[0];
  if(!first)return {
    count:0,inputTokens:AI_PROMPT_OVERHEAD_TOKENS,outputTokens:0,outputBudget:0,targetInputTokens:0,reason:'end',
    newsIds:[],inputChars:AI_PROMPT_OVERHEAD_CHARS,singleOutputTokens:AI_COLD_SINGLE_OUTPUT_TOKENS,legalCompletionRate:2/3,
    predictedWaitMs:0,predictedLatencyMs:0,predictedCompletionAt:now,coldStart:true,starvationOverride:false,
  };
  const fallbackBudgets=modelBudgets(config,first.provider,first.model);
  if(news.length===0)return {
    providerId:first.provider.id,model:first.model.id,count:0,inputTokens:AI_PROMPT_OVERHEAD_TOKENS,outputTokens:0,
    outputBudget:fallbackBudgets.outputBudget,targetInputTokens:Math.floor(fallbackBudgets.targetInput),reason:'end',
    newsIds:[],inputChars:AI_PROMPT_OVERHEAD_CHARS,singleOutputTokens:AI_COLD_SINGLE_OUTPUT_TOKENS,legalCompletionRate:2/3,
    predictedWaitMs:0,predictedLatencyMs:0,predictedCompletionAt:now,coldStart:true,starvationOverride:false,
  };

  const prepared:PreparedNews[]=news.map(item=>{
    const serialized=serializeNews(item);
    const rawTokens=estimateAiTokens(serialized)+16;
    const at=new Date(item.publishedAt).getTime();
    return {id:item.id,serialized,rawTokens,chars:serialized.length+16,publishedAt:Number.isFinite(at)?at:0,lengthBucket:aiLengthBucket(rawTokens)};
  });

  const oldest=prepared.reduce((best,item)=>item.publishedAt<best.publishedAt||(item.publishedAt===best.publishedAt&&item.id<best.id)?item:best);
  const starvationBucket=now-oldest.publishedAt>AI_STARVATION_WAIT_MS?oldest.lengthBucket:undefined;

  const claims=options.probe?AI_PROBE_INTERVAL:(options.successfulClaims ?? 0);
  const probeTarget=options.health?selectAiProbeTarget(options.health,claims):undefined;

  let emptyReason:AiBatchPlanReason='context';
  const collect=(restrictBucket:number|undefined,restrictModel:{providerId:string;model:string}|undefined):Candidate[]=>{
    const candidates:Candidate[]=[];
    for(const entry of models) {
      if(restrictModel&&(entry.provider.id!==restrictModel.providerId||entry.model.id!==restrictModel.model))continue;
      const {provider,model}=entry;
      const windowed=samples
        .filter(sample=>sample.providerId===provider.id&&sample.model===model.id&&(sample.extractionVersion ?? '')===version&&isWithinWindow(sample.observedAt,now))
        .slice(-AI_MAX_OBSERVATIONS);
      const stats=buildModelStats(windowed,options.health?.find(item=>item.providerId===provider.id&&item.model===model.id)?.waitMs ?? 0);
      const {outputBudget,context,targetInput}=modelBudgets(config,provider,model);
      const growthCap=stats.globalLastSuccess!==undefined?Math.ceil(stats.globalLastSuccess*AI_BATCH_GROWTH_FACTOR):Infinity;
      const aggregateCap=Math.min(AI_MAX_NEWS_PER_BATCH,batching.maxNews ?? Infinity,config.scheduling?.maxBatchSize ?? Infinity);
      // 冷启动只受**显式配置**的 initialBatchSize 约束，不受历史 3–5 条上限影响；
      // 首个成功批次之后，增长改由 growthCap（最近成功批量 +25%）控制。
      const coldStartCap=stats.coldStart?(config.scheduling?.initialBatchSize ?? Infinity):Infinity;
      const buckets=new Map<number,PreparedNews[]>();
      for(const item of prepared) {
        if(restrictBucket!==undefined&&item.lengthBucket!==restrictBucket)continue;
        const list=buckets.get(item.lengthBucket) ?? [];
        list.push(item);
        buckets.set(item.lengthBucket,list);
      }
      for(const [bucketKey,items] of buckets) {
        items.sort((a,b)=>a.publishedAt-b.publishedAt||(a.id<b.id?-1:a.id>b.id?1:0));
        const limit=Math.max(0,Math.floor(Math.min(items.length,aggregateCap,growthCap,coldStartCap)));
        let inputSum=0;
        let charsSum=0;
        let chosenN=0;
        let blockedReason:AiBatchPlanReason='end';
        for(let n=1;n<=limit;n++) {
          const item=items[n-1]!;
          const scoped=windowed.filter(sample=>aiBatchSizeBucket(sample.newsCount)===aiBatchSizeBucket(n));
          const scopedStats=computeScopedStats(scoped,stats.coldStart);
          const tokens=stats.inputMultiplier===1?item.rawTokens:Math.max(1,Math.ceil(item.rawTokens*stats.inputMultiplier));
          const nextInput=AI_PROMPT_OVERHEAD_TOKENS+inputSum+tokens;
          const nextChars=AI_PROMPT_OVERHEAD_CHARS+charsSum+item.chars;
          const nextOutput=expectedOutputTokens(n,scopedStats.singleOutputTokens);
          if(nextChars>AI_MAX_REQUEST_CHARS){blockedReason='chars';break;}
          if(nextInput+nextOutput+AI_CONTEXT_SAFETY_TOKENS>context){blockedReason='context';break;}
          if(nextOutput>outputBudget){blockedReason='output';break;}
          if(n>1&&nextInput>targetInput){blockedReason='input';break;}
          inputSum+=tokens;
          charsSum+=item.chars;
          chosenN=n;
        }
        if(chosenN===0){emptyReason=blockedReason==='end'?emptyReason:blockedReason;continue;}
        const scopedStats=computeScopedStats(windowed.filter(sample=>aiBatchSizeBucket(sample.newsCount)===aiBatchSizeBucket(chosenN)),stats.coldStart);
        const latency=stats.predictedLatencyMs(chosenN);
        const boundedByGrowth=Number.isFinite(growthCap)&&chosenN===limit&&limit<items.length&&limit<aggregateCap;
        const reason:AiBatchPlanReason=chosenN<limit?blockedReason:(boundedByGrowth?'growth':(limit===items.length?'end':'count'));
        candidates.push({
          order:entry.order,
          bucketKey,
          score:chosenN*scopedStats.legalCompletionRate/Math.max(1,stats.waitMs+Math.max(1,latency)),
          plan:{
            providerId:provider.id,
            model:model.id,
            count:chosenN,
            inputTokens:AI_PROMPT_OVERHEAD_TOKENS+inputSum,
            outputTokens:expectedOutputTokens(chosenN,scopedStats.singleOutputTokens),
            outputBudget,
            targetInputTokens:Math.floor(targetInput),
            reason,
            newsIds:items.slice(0,chosenN).map(item=>item.id),
            inputChars:AI_PROMPT_OVERHEAD_CHARS+charsSum,
            singleOutputTokens:scopedStats.singleOutputTokens,
            legalCompletionRate:scopedStats.legalCompletionRate,
            predictedWaitMs:stats.waitMs,
            predictedLatencyMs:latency,
            predictedCompletionAt:now+stats.waitMs+latency,
            coldStart:stats.coldStart,
            starvationOverride:restrictBucket!==undefined,
          },
        });
      }
    }
    candidates.sort((a,b)=>b.score-a.score||a.plan.predictedCompletionAt-b.plan.predictedCompletionAt||a.order-b.order||a.bucketKey-b.bucketKey);
    return candidates;
  };

  if(probeTarget) {
    const probeCandidates=collect(undefined,probeTarget);
    if(probeCandidates.length)return probeCandidates[0]!.plan;
  }
  const starved=starvationBucket!==undefined?collect(starvationBucket,undefined):[];
  const candidates=starved.length?starved:collect(undefined,undefined);
  if(candidates.length===0) {
    const {outputBudget,targetInput}=modelBudgets(config,first.provider,first.model);
    return {
      providerId:first.provider.id,model:first.model.id,count:0,inputTokens:AI_PROMPT_OVERHEAD_TOKENS,outputTokens:0,
      outputBudget,targetInputTokens:Math.floor(targetInput),reason:emptyReason,
      newsIds:[],inputChars:AI_PROMPT_OVERHEAD_CHARS,singleOutputTokens:AI_COLD_SINGLE_OUTPUT_TOKENS,legalCompletionRate:2/3,
      predictedWaitMs:0,predictedLatencyMs:0,predictedCompletionAt:now,coldStart:true,starvationOverride:false,
    };
  }
  return candidates[0]!.plan;
}
