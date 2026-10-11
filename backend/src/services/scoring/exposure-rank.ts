/**
 * 股票信息暴露来源排名（单一真源）。
 *
 * 原实现曾在 temp-stock-recommendation-service.ts 与 strategy-runner.ts
 * 中逐字重复；现在收敛到本模块，两个调用方共享同一份白名单与排名规则。
 */

export const stockInfoExposureSources: ReadonlySet<string> = new Set([
  'tickflow_sw_universe',
  'akshare_industry_board_em',
  'akshare_concept_board_em',
  'akshare_individual_info_em',
  'manual_verified',
  'test_exposure',
]);

export type IExposureSourceLike = {
  readonly source?: unknown;
  readonly exposureType?: unknown;
  readonly taxonomyLevel?: unknown;
};

export const stockInfoExposureRank = (exposure: IExposureSourceLike): number => {
  const source = String(exposure.source ?? '');
  const exposureType = String(exposure.exposureType ?? '');
  const taxonomyLevel = String(exposure.taxonomyLevel ?? '').toUpperCase();
  if (source === 'historical_limitup_news' || exposureType === 'movement_evidence') {
    return -1;
  }
  if (!source && !exposureType) {
    return 1;
  }
  if (!stockInfoExposureSources.has(source)) {
    return -1;
  }
  if (source === 'tickflow_sw_universe') {
    if (taxonomyLevel === 'SW3') {
      return 100;
    }
    if (taxonomyLevel === 'SW2') {
      return 90;
    }
    if (taxonomyLevel === 'SW1') {
      return 80;
    }
    return 70;
  }
  if (source === 'akshare_industry_board_em') {
    return 75;
  }
  if (source === 'akshare_concept_board_em') {
    return 65;
  }
  if (source === 'akshare_individual_info_em') {
    return 55;
  }
  return 40;
};
