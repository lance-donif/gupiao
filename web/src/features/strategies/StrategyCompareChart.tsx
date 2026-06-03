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

function fmtPct(v: number | null, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return `${(v * 100).toFixed(digits)}%`;
}

export function StrategyCompareChart({ summaries }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (summaries.length === 0) {
      chart.clear();
      return;
    }

    // 优先用 T+5 > T+3 > T+1 的已结算数据
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

    chart.setOption(
      {
        animation: true,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (params: Array<{ seriesName: string; value: number | null; name: string }>) => {
            const lines = params.map((p) => {
              const unit = p.seriesName === '最大回撤' ? '%' : '%';
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
          data: names,
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
            data: winRates,
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
            data: avgReturns,
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
            data: maxDrawdowns,
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
  }, [summaries]);

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">
        胜率 / 平均收益 / 最大回撤对比（%，取最佳已结算时间窗口）
      </div>
      <div ref={containerRef} style={{ height: 200, width: '100%' }} />
    </div>
  );
}
