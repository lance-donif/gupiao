export const dateKey = (value: Date | string | number): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString().slice(0, 10);
};

/**
 * 可空入参的 UTC 日键。
 *
 * 此前在 scoring-contribution-engine 与 scoring/market-signal-loader 各写了一份
 * 逐字相同的实现，而这两个文件本就互相import —— 提到此处同时消除重复与环依赖。
 */
export const toDayKey = (value: Date | null | undefined): string | null => {
  return value?.toISOString?.().slice(0, 10) ?? null;
};

/** 去重并丢弃空值。用于 symbol/keyword 列表归一。 */
export const uniqueNonEmpty = (values: Iterable<unknown>): string[] => {
  const result: string[] = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) {
      result.push(text);
    }
  }
  return [...new Set(result)];
};

export const toIsoText = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? '');
};

export const toNullableIsoText = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return toIsoText(value);
};
