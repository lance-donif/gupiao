export interface IBackendIntegrationConfig {
  readonly databaseUrl: string;
  readonly aktoolsBaseUrl: string;
  readonly aktoolsMaxResults: number;
}

const DEFAULT_DATABASE_URL = 'postgresql://gupiao:password@localhost:5432/gupiaodb?schema=public';
const DEFAULT_AKTOOLS_BASE_URL = 'http://127.0.0.1:8010';

const parsePositiveInteger = (raw: string | undefined, fallback: number): number => {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${raw}`);
  }

  return parsed;
};

export const createBackendIntegrationConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): IBackendIntegrationConfig => {
  return {
    databaseUrl: environment.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    aktoolsBaseUrl: environment.AKTOOLS_BASE_URL ?? DEFAULT_AKTOOLS_BASE_URL,
    // 不再限制条数，改为按当天日期过滤
    // maxResults 仅作为兜底，设为极大值
    aktoolsMaxResults: parsePositiveInteger(environment.AKTOOLS_MAX_RESULTS, 10000),
  };
};

export const requireEnvironmentValue = (value: string | undefined, key: string): string => {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
};
