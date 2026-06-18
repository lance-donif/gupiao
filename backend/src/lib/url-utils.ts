export const normalizeBaseUrl = (value: string): string => {
  return value.replace(/\/+$/u, '');
};

export const toNonEmptyString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim().replace(/\s+/gu, ' ');
  return text.length > 0 ? text : null;
};
