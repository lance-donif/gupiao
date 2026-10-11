/**
 * 展示层格式化工具。全部页面共用，避免各文件重复实现。
 * 纯函数，不含 React —— hook 见 src/hooks/use-debounced-value.ts。
 */

/** A股约定：红涨绿跌。统一走语义类，杜绝各处硬编码方向写反。 */
export function changeToneClass(value: number | null | undefined, neutralClass = 'text-muted-foreground'): string {
  if (value == null || !Number.isFinite(value)) {
    return neutralClass;
  }
  return value >= 0 ? 'stock-up' : 'stock-down';
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  const pct = value * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

export function formatScore(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  return value.toFixed(digits);
}

export function formatMinute(value: string | null | undefined): string {
  if (!value) {
    return '--';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.slice(5, 16).replace('-', '/');
  }
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hour = String(parsed.getHours()).padStart(2, '0');
  const minute = String(parsed.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
}

export function todayDate(): string {
  return new Date().toLocaleDateString('en-CA');
}