import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * 工作台通用展示原语。
 *
 * Dashboard 与 RecommendationHistory 此前各自实现了一份 Metric，
 * 仅圆角与图标不同；这里合并为一个可配置组件，视觉保持调用方原样。
 */

const METRIC_VARIANTS = {
  /** Dashboard 内嵌卡片内的紧凑指标 */
  compact: 'rounded-md border border-border bg-background p-2',
  /** 页面级指标卡 */
  panel: 'workstation-control rounded-xl p-3',
} as const;

export function Metric({
  label,
  value,
  icon,
  variant = 'compact',
  className,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  variant?: keyof typeof METRIC_VARIANTS;
  className?: string;
}) {
  if (variant === 'panel') {
    return (
      <div className={cn(METRIC_VARIANTS.panel, className)}>
        <div className="text-[11px] font-semibold leading-4 text-muted-foreground">{label}</div>
        <div className="number-figure mt-1 text-[16px] font-bold leading-6">{value}</div>
      </div>
    );
  }
  return (
    <div className={cn(METRIC_VARIANTS.compact, className)}>
      <div className="flex items-center gap-1 text-[10px] font-semibold leading-4 text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[14px] font-bold leading-5">{value}</div>
    </div>
  );
}

export function MiniMetric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="workstation-control rounded-sm px-2 py-1">
      <div className="text-[10px] leading-4 text-muted-foreground">{label}</div>
      <div className={cn('number-figure text-[12px] font-semibold leading-4', className)}>{value}</div>
    </div>
  );
}

/**
 * 空状态占位。
 *
 * 高度使用 min-h-*（弹性下限）而非固定高度，符合 AGENTS.md 的布局约束；
 * compact 用于已处于 flex-1 min-h-0 弹性区域内的场景。
 */
export function EmptyBlock({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-full min-h-[96px] items-center justify-center rounded-lg border border-dashed border-border bg-background text-center text-[12px] leading-5 text-muted-foreground',
        compact && 'min-h-0 px-3 py-3',
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" />
        <span>{text}</span>
      </div>
    </div>
  );
}