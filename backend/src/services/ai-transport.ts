import { readOpenAiStream } from '../lib/openai-stream.js';
import { extractJsonObject } from '../lib/openai-utils.js';
import { isAiRecord } from './ai-provider-config.js';
import type { AiCandidate, AiResponseMetrics } from './ai-adaptive-scheduler.js';
import { AiCallFailure, classifyAiHttp } from './ai-scheduling-errors.js';
import { aiRequestContext } from './ai-request-context.js';

export async function performAiRequest<T>(candidate: AiCandidate, fetchImpl: typeof fetch, validate: (value: unknown)=>T, metrics: AiResponseMetrics, signal?: AbortSignal): Promise<T> {
  const started=Date.now();
  const controller=new AbortController();
  const caller=signal ?? aiRequestContext.getStore()?.signal;
  caller?.throwIfAborted();
  const total=candidate.model.timeouts?.totalMs ?? candidate.model.timeoutMs ?? 180000;
  const first=Math.min(total,candidate.model.timeouts?.firstResponseMs ?? 45000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let cancel: (()=>void) | undefined;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  try {
    const deadline=new Promise<never>((_resolve,reject)=>{
      cancel=()=>{controller.abort();reject(caller?.reason ?? new AiCallFailure('network'));};
      caller?.addEventListener('abort',cancel,{once:true});
      const timeout=(kind:'first_timeout'|'total_timeout')=>{controller.abort();reject(new AiCallFailure(kind));};
      timer=setTimeout(()=>timeout('total_timeout'),total);
      firstTimer=setTimeout(()=>timeout('first_timeout'),first);
    });
    const perform=async ():Promise<T>=>{
      response=await fetchImpl(candidate.provider.baseUrl.replace(/\/+$/,'')+'/chat/completions',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+candidate.provider.apiKey},body:candidate.serialized,signal:controller.signal,
      });
      metrics.headers=response.headers;
      if(!response.ok) {
        const reader=response.body?.getReader();
        let diagnostic='';
        try { while(reader && diagnostic.length<16000) { const part=await reader.read(); if(part.done)break; diagnostic+=new TextDecoder().decode(part.value); } }
        finally { await reader?.cancel().catch(()=>undefined); }
        throw classifyAiHttp(response.status,diagnostic,response.headers);
      }
      let content:unknown;
      if(candidate.model.parameters?.stream) {
        try {
          content=await readOpenAiStream(response,total,{idleMs:candidate.model.timeouts?.idleMs ?? 45000,onProgress:()=>clearTimeout(firstTimer),onUsage:value=>{usage=value;},onTokens:tokens=>{metrics.tokens=tokens;},errorFactory:error=>classifyAiHttp(502,JSON.stringify(error),response!.headers)});
        } catch(error) {
          if(error instanceof AiCallFailure)throw error;
          const message=error instanceof Error?error.message:'';
          throw new AiCallFailure(message.includes('length')?'length':message.includes('content_filter')?'refusal':message.includes('timed out')?'idle_timeout':'structure');
        }
      } else {
        const payload:unknown=await response.json().catch(()=>{throw new AiCallFailure('structure');});
        clearTimeout(firstTimer);
        if(!isAiRecord(payload))throw new AiCallFailure('structure');
        if(payload.error)throw classifyAiHttp(502,JSON.stringify(payload.error),response.headers);
        if(isAiRecord(payload.usage) && typeof payload.usage.total_tokens==='number')metrics.tokens=payload.usage.total_tokens;
        if(isAiRecord(payload.usage)) usage=payload.usage;
        const choice=Array.isArray(payload.choices)?payload.choices[0]:undefined;
        if(!isAiRecord(choice))throw new AiCallFailure('structure');
        if(choice.finish_reason==='length')throw new AiCallFailure('length');
        if(choice.finish_reason==='content_filter')throw new AiCallFailure('refusal');
        if(choice.finish_reason!=null && choice.finish_reason!=='stop')throw new AiCallFailure('structure');
        if(isAiRecord(choice.message) && choice.message.refusal)throw new AiCallFailure('refusal');
        content=isAiRecord(choice.message)?choice.message.content:undefined;
      }
      if(typeof content!=='string' || !content.trim())throw new AiCallFailure('structure');
      try {
        const value=validate(JSON.parse(extractJsonObject(content)));
        const measured=typeof usage?.prompt_tokens==='number' && usage.prompt_tokens>0 && typeof usage.completion_tokens==='number' && usage.completion_tokens>=0;
        metrics.performance={inputTokens:measured?usage!.prompt_tokens!:Buffer.byteLength(candidate.serialized,'utf8'),outputTokens:measured?usage!.completion_tokens!:Buffer.byteLength(content,'utf8'),latencyMs:Date.now()-started,tokenSource:measured?'usage':'byte_bound'};
        return value;
      }
      catch { throw new AiCallFailure('structure'); }
    };
    return await Promise.race([perform(),deadline]);
  } finally {
    clearTimeout(timer);clearTimeout(firstTimer);
    if(cancel)caller?.removeEventListener('abort',cancel);
    controller.abort();
    if(response?.body && !response.body.locked)void response.body.cancel().catch(()=>undefined);
  }
}
