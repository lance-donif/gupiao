import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { IAiProviderConfig, IAiProvider, IAiLimits } from './ai-provider-config.js';
import type { AiSchedulerStore, AiLease } from './ai-scheduler-store.js';
import { AiCallFailure, AiNeedsAttentionError, AiPausedError, AiSplitRequiredError } from './ai-scheduling-errors.js';
import { aiRequestContext } from './ai-request-context.js';

export interface AiCandidate {
  readonly provider: IAiProvider;
  readonly model: IAiProvider['models'][number];
  readonly serialized: string;
}
interface Scope { key: string; identity: string; limits: IAiLimits; }
export interface AiResponseMetrics { headers?: Headers; tokens?: number; performance?:{inputTokens:number;outputTokens:number;latencyMs:number;tokenSource?:'usage'|'byte_bound'}; }
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const candidateKey = (c: AiCandidate): string => JSON.stringify([c.provider.id, c.model.id]);

export class AiAdaptiveScheduler {
  public constructor(private readonly config: IAiProviderConfig, public readonly store: AiSchedulerStore,
    private readonly now = Date.now, private readonly random = Math.random) {}

  private scopes(candidate: AiCandidate): Scope[] {
    const p = candidate.provider;
    const identity = digest(JSON.stringify([p.baseUrl, p.apiKey]));
    const scopes: Scope[] = [
      { key: `provider:${p.id}`, identity, limits: p.limits ?? {} },
      { key: `model:${candidateKey(candidate)}`, identity: digest(identity + JSON.stringify([candidate.model.id, candidate.model.parameters])), limits: candidate.model.limits ?? {} },
    ];
    if (p.quotaGroup) scopes.unshift({ key: `group:${p.quotaGroup}`, identity: digest(JSON.stringify(this.config.providers.filter(x=>x.quotaGroup===p.quotaGroup).map(x=>[x.id,x.apiKey]).sort())), limits: this.config.quotaGroups?.[p.quotaGroup] ?? {} });
    return scopes;
  }

  public async acquire(candidates: readonly AiCandidate[], excluded = new Set<string>()): Promise<{ candidate?: AiCandidate; lease?: AiLease; waitMs: number; unavailable?: boolean; tooLarge?: boolean }> {
    const now = this.now();
    return this.store.transact(snapshot => {
      snapshot.leases = snapshot.leases.filter(lease => lease.expiresAt > now);
      let next = Infinity;
      let possible = 0;
      let oversized = 0;
      const eligible: { candidate: AiCandidate; scopes: Scope[]; score: number; tokens: number }[] = [];
      for (const candidate of candidates) {
        if (excluded.has(candidateKey(candidate))) continue;
        const scopes = this.scopes(candidate);
        const body=JSON.parse(candidate.serialized);
        const tokens = Buffer.byteLength(candidate.serialized, 'utf8') + Number(body.max_completion_tokens ?? body.max_tokens ?? aiRequestContext.getStore()?.outputTokenBudget ?? 4096);
        if(tokens>(candidate.model.limits?.contextTokens ?? 128000)){oversized++;continue;}
        if (scopes.some(scope=>scope.limits.contextTokens && tokens>scope.limits.contextTokens)) {oversized++;continue;}
        let readyAt = now;
        let disabled = false;
        let score = 0;
        for (const scope of scopes) {
          let state = snapshot.health[scope.key];
          if (!state || state.identity !== scope.identity) {
            state = snapshot.health[scope.key] = { identity: scope.identity, capacity: Math.min(scope.limits.initialConcurrency ?? 2, scope.limits.maxConcurrency ?? 5), successes: 0, stableSince: now, failures: 0, cooldownUntil: 0, disabled: false, probing: false, latency: 30000, validRate: 0.8, nextStart: 0, minute: [], day: '', dayRequests: 0, dayTokens: 0 };
          }
          state.capacity = Math.min(state.capacity, scope.limits.maxConcurrency ?? 5);
          state.minute = state.minute.filter(item => item.at > now - 60000);
          const day = new Date(now).toISOString().slice(0, 10);
          if (state.day !== day) { state.day = day; state.dayRequests = 0; state.dayTokens = 0; }
          if (state.disabled) { disabled = true; break; }
          const active = snapshot.leases.filter(lease => lease.scopes.includes(scope.key)).length;
          readyAt = Math.max(readyAt, state.cooldownUntil, state.nextStart);
          if (active >= (state.probing ? 1 : state.capacity)) readyAt = Math.max(readyAt, now + 500);
          const rpm = Math.min(scope.limits.rpm ?? Infinity, state.learnedRpm ?? Infinity);
          const tpm = Math.min(scope.limits.tpm ?? Infinity, state.learnedTpm ?? Infinity);
          if (tokens > tpm || (scope.limits.dailyTokens && tokens > scope.limits.dailyTokens)) { disabled = true; oversized++; break; }
          if (state.minute.length >= rpm || state.minute.reduce((sum,item)=>sum+item.tokens,0)+tokens > tpm) readyAt = Math.max(readyAt, (state.minute[0]?.at ?? now) + 60001);
          if (state.dayRequests >= (scope.limits.dailyRequests ?? Infinity) || state.dayTokens + tokens > (scope.limits.dailyTokens ?? Infinity)) readyAt = Math.max(readyAt, Date.parse(day+'T00:00:00Z') + 86400000);
          score += state.latency / Math.max(0.05, state.validRate) * (1 + active / state.capacity);
        }
        if (disabled) continue;
        possible++;
        if (readyAt > now) { next = Math.min(next, readyAt); continue; }
        eligible.push({ candidate, scopes, score, tokens });
      }
      if (snapshot.leases.length >= (this.config.scheduling?.globalConcurrency ?? 10)) return { waitMs: 500 };
      eligible.sort((a,b)=>a.score-b.score);
      const selected = eligible[0];
      if (!selected) return { waitMs: Number.isFinite(next) ? Math.max(50,next-now) : 1000, unavailable: possible === 0,tooLarge:possible===0 && oversized>0 };
      const remaining=Math.max(1,(aiRequestContext.getStore()?.deadline ?? now+(this.config.scheduling?.runTimeoutMs ?? 3600000))-now);
      const lease: AiLease = { id: randomUUID(), candidate: candidateKey(selected.candidate), scopes: selected.scopes.map(scope=>scope.key), tokens: selected.tokens, startedAt: now, expiresAt: now + Math.min(remaining,selected.candidate.model.timeouts?.totalMs ?? selected.candidate.model.timeoutMs ?? 180000) + 30000 };
      for (const scope of selected.scopes) {
        const state = snapshot.health[scope.key];
        state.nextStart = now + (scope.limits.minSpacingMs ?? 1000);
        state.minute.push({ at: now, tokens: selected.tokens });
        state.dayRequests++; state.dayTokens += selected.tokens;
      }
      snapshot.leases.push(lease);
      return { candidate: selected.candidate, lease, waitMs: 0 };
    }, aiRequestContext.getStore(), true);
  }

  public async finish(candidate: AiCandidate, lease: AiLease, error?: AiCallFailure, metrics: AiResponseMetrics = {}, cancelled = false): Promise<void> {
    const now = this.now();
    await this.store.transact(snapshot => {
      snapshot.leases = snapshot.leases.filter(item=>item.id!==lease.id);
      for (const scope of this.scopes(candidate)) {
        const state = snapshot.health[scope.key];
        if (!state || state.identity !== scope.identity || cancelled) continue;
        if (Number.isFinite(metrics.tokens) && metrics.tokens! >= 0) {
          const used = state.minute.find(item=>item.at===lease.startedAt && item.tokens===lease.tokens);
          if (used) used.tokens = metrics.tokens!;
          if(state.day===new Date(lease.startedAt).toISOString().slice(0,10)) state.dayTokens = Math.max(0,state.dayTokens + metrics.tokens! - lease.tokens);
        }
        // Header scope is generally account-wide; apply it conservatively to both provider and model.
        for (const [header, key] of [['x-ratelimit-limit-requests','learnedRpm'],['x-ratelimit-limit-tokens','learnedTpm']] as const) {
          const value = Number(metrics.headers?.get(header));
          if (Number.isFinite(value) && value > 0) state[key] = value;
        }
        // Content rejection describes the input, not the provider's availability.
        if (error?.kind === 'refusal') continue;
        // Invalid credentials belong to one entry even when it shares an account quota group.
        if (error?.kind === 'auth' && scope.key.startsWith('group:')) continue;
        const modelOnly = error && ['missing_model','structure','length','refusal','parameter','permission','first_timeout','idle_timeout','total_timeout'].includes(error.kind);
        if (modelOnly && !scope.key.startsWith('model:')) continue;
        state.validRate = state.validRate*0.8 + (error ? 0 : 0.2);
        if (!error) {
          state.latency = state.latency*0.8 + Math.max(1,now-lease.startedAt)*0.2;
          state.failures = 0; state.successes++; state.probing = false;
          if (state.successes >= 10 && now-state.stableSince >= 120000) {
            state.capacity = Math.min(scope.limits.maxConcurrency ?? 5,state.capacity+1);
            state.successes=0; state.stableSince=now;
          }
          continue;
        }
        state.successes=0; state.stableSince=now; state.failures++;
        if (error.kind==='auth' || error.kind==='missing_model' || error.kind==='parameter' || (error.kind==='quota' && !error.retryAt)) { state.disabled=true; continue; }
        if (error.kind==='rate') state.capacity=Math.max(1,Math.floor(state.capacity/2));
        const base = error.kind==='permission' ? 900000 : error.kind==='rate' ? 30000 : 2000;
        const backoff = Math.min(error.kind==='permission' ? 900000 : 300000,base * 2**Math.min(state.failures-1,6));
        const cooldown = error.retryAt ?? (now + backoff/2 + this.random()*backoff/2);
        state.cooldownUntil=Math.max(state.cooldownUntil,cooldown);
        if (state.failures>=3) { state.probing=true; state.cooldownUntil=Math.max(state.cooldownUntil,now+60000); state.capacity=1; }
      }
    });
    await this.store.record({ id: lease.id, candidate: lease.candidate, taskId: aiRequestContext.getStore()?.taskId, status: cancelled?'CANCELLED':error?'FAILED':'SUCCESS', kind:error?.kind, httpStatus:error?.status, latencyMs:now-lease.startedAt });
  }

  public async execute<T>(candidates: readonly AiCandidate[], perform: (candidate: AiCandidate, metrics: AiResponseMetrics, signal:AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<{ value: T; candidate: AiCandidate;metrics:AiResponseMetrics }> {
    const context=aiRequestContext.getStore();
    const deadline=context?.deadline ?? this.now()+(this.config.scheduling?.runTimeoutMs ?? 3600000);
    const controller=new AbortController();
    const combined=AbortSignal.any([controller.signal,...(signal?[signal]:[]),...(context?[context.signal]:[])]);
    const timer=setTimeout(()=>controller.abort(new AiPausedError('AI run reached its one-hour deadline')),Math.max(1,deadline-this.now()));
    try{return await this.executeUntil(candidates,perform,combined,deadline);}
    finally{clearTimeout(timer);}
  }
  private async executeUntil<T>(candidates:readonly AiCandidate[],perform:(candidate:AiCandidate,metrics:AiResponseMetrics,signal:AbortSignal)=>Promise<T>,signal:AbortSignal,deadline:number):Promise<{value:T;candidate:AiCandidate;metrics:AiResponseMetrics}> {
    const context=aiRequestContext.getStore();
    const maximum=context?.maxAttempts ?? this.config.scheduling?.maxAttempts ?? 24;
    const excluded=new Set<string>();
    let structureFailures=0;
    let calls=0;
    while (this.now()<deadline) {
      signal?.throwIfAborted(); context?.signal.throwIfAborted();
      if(calls>=maximum) throw new AiNeedsAttentionError('AI request budget exhausted');
      const next=await this.acquire(candidates,excluded);
      if(!next.candidate || !next.lease) {
        if(next.unavailable) {
          if(excluded.size) { excluded.clear(); continue; }
          if(next.tooLarge)throw new AiSplitRequiredError('No available AI model can fit this input within configured token limits');
          throw new AiNeedsAttentionError('No eligible AI model: credentials, quota, permissions or input capacity require attention');
        }
        if(context)await this.store.waiting?.(context,Math.min(deadline,this.now()+next.waitMs));
        await delay(Math.min(1000,next.waitMs,Math.max(1,deadline-this.now())),undefined,{signal:signal??context?.signal});
        continue;
      }
      const {candidate,lease}=next;
      calls++;
      const metrics: AiResponseMetrics={};
      let value: T;
      try { value=await perform(candidate,metrics,signal); }
      catch (error) {
        const cancelled=!!(signal?.aborted || context?.signal.aborted);
        const failure=error instanceof AiCallFailure ? error : new AiCallFailure('network');
        await this.finish(candidate,lease,failure,metrics,cancelled);
        if(cancelled) { (signal?.aborted?signal:context?.signal)?.throwIfAborted(); }
        console.warn(`[ai] ${candidate.provider.id}/${candidate.model.id} ${failure.message}`);
        excluded.add(candidateKey(candidate));
        if(failure.kind==='length' || failure.kind==='refusal') throw new AiSplitRequiredError(failure.message);
        if(failure.kind==='structure' && ++structureFailures>=2) throw new AiSplitRequiredError('Repeated invalid AI structure; split input');
        continue;
      }
      await this.finish(candidate,lease,undefined,metrics);
      return {value,candidate,metrics};
    }
    throw new AiPausedError('AI run reached its one-hour deadline');
  }
}
