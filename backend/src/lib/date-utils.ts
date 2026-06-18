export const dateKey = (value: Date | string | number): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString().slice(0, 10);
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
