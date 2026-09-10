/**
 * 流水线阶段契约：阶段 ID、依赖图、产物/运行上下文/阶段接口，以及 legacy 步骤名映射。
 *
 * 纯声明式模块，不含副作用；`resolveStageOrder` 对依赖图做确定性拓扑排序，
 * 供后续阶段注册表/执行器复用。
 */

/** 14 个流水线阶段的稳定标识。 */
export type StageId =
  | 'news_fetch'
  | 'news_prepare'
  | 'exposure_refresh'
  | 'causal_extract'
  | 'graph_snapshot'
  | 'market_features'
  | 'expectation_gap'
  | 'theme_forecast'
  | 'penalty_refresh'
  | 'evidence_score'
  | 'recommendation_select'
  | 'recommendation_publish'
  | 'reconciliation'
  | 'strategy_evaluation';

/** 阶段逻辑顺序，也是同层排序的 tie-breaker。 */
export const STAGE_IDS: readonly StageId[] = [
  'news_fetch',
  'news_prepare',
  'exposure_refresh',
  'causal_extract',
  'graph_snapshot',
  'market_features',
  'expectation_gap',
  'theme_forecast',
  'penalty_refresh',
  'evidence_score',
  'recommendation_select',
  'recommendation_publish',
  'reconciliation',
  'strategy_evaluation',
];

/** 阶段直接依赖（前置阶段必须全部完成后才能运行）。 */
export const STAGE_DEPENDENCIES: Readonly<Record<StageId, readonly StageId[]>> = {
  news_fetch: [],
  news_prepare: ['news_fetch'],
  exposure_refresh: [],
  causal_extract: ['news_prepare'],
  graph_snapshot: ['causal_extract'],
  market_features: [],
  expectation_gap: ['graph_snapshot', 'exposure_refresh', 'market_features'],
  theme_forecast: ['causal_extract', 'exposure_refresh', 'expectation_gap'],
  penalty_refresh: [],
  evidence_score: [
    'news_prepare',
    'causal_extract',
    'exposure_refresh',
    'graph_snapshot',
    'market_features',
    'penalty_refresh',
  ],
  recommendation_select: ['evidence_score'],
  recommendation_publish: ['recommendation_select'],
  reconciliation: ['recommendation_publish'],
  strategy_evaluation: ['evidence_score'],
};

const STAGE_INDEX: ReadonlyMap<StageId, number> = new Map(
  STAGE_IDS.map((id, index) => [id, index] as const),
);

/** 反向依赖（谁依赖了我），用于失效传播；按 STAGE_IDS 顺序稳定输出。 */
const STAGE_DEPENDENTS: Readonly<Record<StageId, readonly StageId[]>> = (() => {
  const map = Object.fromEntries(
    STAGE_IDS.map(id => [id, [] as StageId[]] as const),
  ) as Record<StageId, StageId[]>;
  for (const id of STAGE_IDS) {
    for (const dependency of STAGE_DEPENDENCIES[id]) {
      map[dependency].push(id);
    }
  }
  return map;
})();

/** 不可变产物引用：定位一次阶段执行产出的稳定内容。 */
export interface ArtifactRef<T> {
  artifactId: string;
  traceId: string;
  stageId: StageId;
  version: string;
  contentHash: string;
  shardCount: number;
  payload: T;
}

/** 一次流水线运行的稳定上下文键。 */
export interface RunContext {
  traceId: string;
  clusterKey: string;
  mode: string;
  asOf: string;
  recipeVersion: string;
  businessConfigHash: string;
  inputs: Readonly<Record<string, string>>;
  businessConfig: unknown;
  signal?: AbortSignal;
}

/** 单个流水线阶段的契约。 */
export interface PipelineStage<I, O> {
  readonly id: StageId;
  readonly version: string;
  readonly dependencies: readonly StageId[];
  buildInput(context: RunContext): Promise<I>;
  fingerprint(input: I): string;
  execute(context: RunContext, input: I): Promise<ArtifactRef<O>>;
}

/**
 * 现有脚本中步骤名（legacy step name）到阶段 ID 的映射。
 * 全部逐字取自 `backend/scripts/run-daily-recommendation.ts`。
 */
export const LEGACY_STEP_TO_STAGE: Readonly<Record<string, StageId>> = {
  news_fetch: 'news_fetch',
  normalize: 'news_prepare',
  deduplicate: 'news_prepare',
  persist_news: 'news_prepare',
  stock_exposure_aktools: 'exposure_refresh',
  stock_exposure_tickflow: 'exposure_refresh',
  causal_signal_extraction: 'causal_extract',
  graph_snapshot: 'graph_snapshot',
  candle_preflight_check: 'market_features',
  expectation_gap: 'expectation_gap',
  theme_forecast: 'theme_forecast',
  keyword_performance_penalty_refresh: 'penalty_refresh',
  scoring_recommendation: 'evidence_score',
  autopilot_evaluation: 'strategy_evaluation',
  forecast_source_resolve: 'market_features',
  causal_signal_copy: 'causal_extract',
  graph_snapshot_copy: 'graph_snapshot',
  forecast_lookup: 'theme_forecast',
};

/**
 * 确定性拓扑排序：Kahn 算法，就绪节点按 `STAGE_IDS` 顺序贪心取最靠前者。
 * 在阶段的逻辑顺序本身就是合法拓扑序时，返回值与 `STAGE_IDS` 完全一致，
 * 从而与现有脚本的串行执行顺序保持同构。
 * 存在环时抛出错误，绝不返回部分结果。
 */
export function resolveStageOrder(): readonly StageId[] {
  const remaining = new Map<StageId, number>();
  for (const id of STAGE_IDS) {
    remaining.set(id, STAGE_DEPENDENCIES[id].length);
  }

  const ordered: StageId[] = [];
  let ready = STAGE_IDS.filter(id => (remaining.get(id) ?? 0) === 0);

  while (ready.length > 0) {
    const next = ready[0];
    ready = ready.slice(1);
    ordered.push(next);
    for (const dependent of dependentsOf(next)) {
      const left = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, left);
      if (left === 0) {
        ready = [...ready, dependent].sort(
          (left_, right_) => (STAGE_INDEX.get(left_) ?? 0) - (STAGE_INDEX.get(right_) ?? 0),
        );
      }
    }
  }

  if (ordered.length !== STAGE_IDS.length) {
    throw new Error(`阶段依赖存在环，无法完成拓扑排序：已排序 ${ordered.length}/${STAGE_IDS.length}`);
  }

  return ordered;
}

/** 返回某阶段的直接依赖。 */
export function dependenciesOf(id: StageId): readonly StageId[] {
  return STAGE_DEPENDENCIES[id];
}

/** 返回依赖某阶段的所有阶段（反向依赖）。 */
export function dependentsOf(id: StageId): readonly StageId[] {
  return STAGE_DEPENDENTS[id];
}

/** 判断某阶段的所有依赖是否都已在 `completed` 集合内。 */
export function dependenciesSatisfied(id: StageId, completed: ReadonlySet<StageId>): boolean {
  return STAGE_DEPENDENCIES[id].every(dependency => completed.has(dependency));
}
