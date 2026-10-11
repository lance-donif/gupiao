import * as React from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { StrategyProfitSummary } from '@/lib/api-types';

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  summaries: StrategyProfitSummary[];
}

export function StrategyCompareChart({ summaries }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 容器位于 flex-1 min-h-0 内，首帧可能拿到 0 高度；此时 init 会触发 ECharts 尺寸告警。
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
    chartRef.current = echarts.init(el, undefined, { renderer: 'canvas' });
    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  const seriesData = React.useMemo(() => {
    function pickHorizon(item: StrategyProfitSummary) {
      const h = item.horizon_summaries;
      if (!h) return null;
      if (h.t5.final_count > 0) return h.t5;
      if (h.t3.final_count > 0) return h.t3;
      if (h.t1.final_count > 0) return h.t1;
      return null;
    }
    const names = summaries.map((s) => s.strategy_name);
    const winRates = summaries.map((s) => {
      const h = pickHorizon(s);
      return h?.win_rate != null ? +(h.win_rate * 100).toFixed(1) : null;
    });
    const avgReturns = summaries.map((s) => {
      const h = pickHorizon(s);
      return h?.avg_return_pct != null ? +(h.avg_return_pct * 100).toFixed(1) : null;
    });
    const maxDrawdowns = summaries.map((s) => {
      const h = pickHorizon(s);
      if (h?.max_drawdown_pct == null) return null;
      return +(Math.abs(h.max_drawdown_pct) * 100).toFixed(1);
    });
    return { names, winRates, avgReturns, maxDrawdowns };
  }, [summaries]);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (summaries.length === 0) {
      chart.clear();
      return;
    }

    chart.setOption(
      {
        animation: false,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (params: Array<{ seriesName: string; value: number | null; name: string }>) => {
            const lines = params.map((p) => {
              const unit = '%';
              return `${p.seriesName}: ${p.value != null ? `${p.value}${unit}` : '--'}`;
            });
            return `<b>${params[0]?.name}</b><br/>${lines.join('<br/>')}`;
          },
        },
        legend: {
          top: 0,
          right: 0,
          textStyle: { fontSize: 11 },
          itemHeight: 10,
        },
        grid: { left: 8, right: 8, bottom: 8, top: 36, containLabel: true },
        xAxis: {
          type: 'category',
          data: seriesData.names,
          axisLabel: { fontSize: 10, interval: 0, overflow: 'truncate', width: 72 },
        },
        yAxis: {
          type: 'value',
          axisLabel: { formatter: '{value}%', fontSize: 10 },
          splitLine: { lineStyle: { type: 'dashed', color: '#e5e7eb' } },
        },
        series: [
          {
            name: 'T+x胜率',
            type: 'bar',
            data: seriesData.winRates,
            itemStyle: { color: '#3b82f6', borderRadius: [3, 3, 0, 0] },
            label: {
              show: true,
              position: 'top',
              fontSize: 10,
              formatter: (p: { value: number | null }) =>
                p.value != null ? `${p.value}%` : '',
            },
          },
          {
            name: '平均收益',
            type: 'bar',
            data: seriesData.avgReturns,
            itemStyle: { color: '#10b981', borderRadius: [3, 3, 0, 0] },
            label: {
              show: true,
              position: 'top',
              fontSize: 10,
              formatter: (p: { value: number | null }) =>
                p.value != null ? `${p.value > 0 ? '+' : ''}${p.value}%` : '',
            },
          },
          {
            name: '最大回撤',
            type: 'bar',
            data: seriesData.maxDrawdowns,
            itemStyle: { color: '#f43f5e', borderRadius: [3, 3, 0, 0] },
            label: {
              show: true,
              position: 'top',
              fontSize: 10,
              formatter: (p: { value: number | null }) =>
                p.value != null ? `-${p.value}%` : '',
            },
          },
        ],
      },
      true,
    );
  }, [seriesData]);

  return (
    <div className="space-y-1">
      <div id="strategy-compare-desc" className="text-[11px] text-muted-foreground">
        胜率 / 平均收益 / 最大回撤对比（%，取最佳已结算时间窗口）
      </div>
      {/* 高度交给 CSS：内联 style 硬编码 200px 无法响应式，也违反 AGENTS.md 的弹性高度约束 */}
      <div
        ref={containerRef}
        role="img"
        aria-labelledby="strategy-compare-desc"
        aria-label={`策略对比柱状图：${seriesData.names.join('、')}`}
        className="h-[200px] w-full min-h-[180px] xl:h-[240px]"
      />
    </div>
  );
}
