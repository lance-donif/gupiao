const BEIJING_TIME_ZONE = 'Asia/Shanghai';

const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: BEIJING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const parseBeijingIsoLike = (value: string): Date | null => {
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T00:00:00+08:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}+08:00`);
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }
  return parsed;
};

export const toBeijingDateTime = (value: Date | string | number = new Date()): string => {
  const date
    = value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : parseBeijingIsoLike(value) ?? new Date(value);
  return formatter.format(date).replace('T', ' ');
};

export const toBeijingDate = (value: Date | string | number = new Date()): string => {
  return toBeijingDateTime(value).slice(0, 10);
};

export const toEpochSeconds = (value: Date | string | number): number => {
  const date
    = value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : parseBeijingIsoLike(value) ?? new Date(value);
  return Math.floor(date.getTime() / 1000);
};

export const nowBeijingDateTime = (): string => toBeijingDateTime(new Date());
