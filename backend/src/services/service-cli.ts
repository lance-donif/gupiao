import type { INewsIngestExecutionRequest } from './news-ingest-types.js';
import type { IServiceCompositionRoot } from './service-di.js';
import type { IServiceCliRunResult } from './service-summary.js';

import type { IServiceTimeWindow } from './service-types.js';
import type { IStockSyncExecutionRequest } from './stock-sync-types.js';
import { createServiceCompositionRoot } from './service-di.js';
import {
  createHelpResult,

  toCliRunResult,
} from './service-summary.js';

type ServiceCliCommand = 'help' | 'news-ingest' | 'stock-sync';

type CliOptions = Readonly<Record<string, string | boolean>>;

const HELP_TEXT = [
  'service-cli',
  '',
  'Commands:',
  '  news-ingest --cluster <cluster> --query <query> [--as-of <iso>] [--window-start <iso> --window-end <iso>] [--limit <n>] [--dry-run]',
  '  stock-sync --cluster <cluster> --symbol <symbol> --stock-id <id> --stock-name <name> --industry <industry> [--as-of <iso>] [--window-start <iso> --window-end <iso>] [--limit <n>] [--dry-run]',
].join('\n');

const isFlag = (value: string): boolean => {
  return value.startsWith('--');
};

const toNumberOption = (value: string | boolean | undefined): number | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`Expected numeric option but received: ${value}`);
  }

  return parsed;
};

const toDateOption = (value: string | boolean | undefined, key: string): Date | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Expected ISO datetime for --${key} but received: ${value}`);
  }

  return date;
};

const parseTimeWindow = (options: CliOptions): IServiceTimeWindow | undefined => {
  const start = toDateOption(options['window-start'], 'window-start');
  const end = toDateOption(options['window-end'], 'window-end');

  if (!start && !end) {
    return undefined;
  }

  if (!start || !end) {
    throw new Error('Both --window-start and --window-end are required when specifying a time window');
  }

  return {
    start,
    end,
  };
};

const getRequiredString = (options: CliOptions, key: string): string => {
  const value = options[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required option: --${key}`);
  }

  return value;
};

const parseOptions = (argv: readonly string[]): CliOptions => {
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!isFlag(token)) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || isFlag(next)) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return Object.freeze(options);
};

const parseNewsIngestRequest = (options: CliOptions): INewsIngestExecutionRequest => {
  return {
    cluster: getRequiredString(options, 'cluster'),
    query: getRequiredString(options, 'query'),
    asOf: toDateOption(options['as-of'], 'as-of'),
    timeWindow: parseTimeWindow(options),
    limit: toNumberOption(options.limit),
  };
};

const parseStockSyncRequest = (options: CliOptions): IStockSyncExecutionRequest => {
  return {
    cluster: getRequiredString(options, 'cluster'),
    symbol: getRequiredString(options, 'symbol'),
    stockId: getRequiredString(options, 'stock-id'),
    stockName: getRequiredString(options, 'stock-name'),
    industry: getRequiredString(options, 'industry'),
    asOf: toDateOption(options['as-of'], 'as-of'),
    timeWindow: parseTimeWindow(options),
    limit: toNumberOption(options.limit),
  };
};

const parseCommand = (argv: readonly string[]): {
  readonly command: ServiceCliCommand;
  readonly args: readonly string[];
} => {
  const [command, ...args] = argv;

  if (!command || command === '--help' || command === 'help') {
    return {
      command: 'help',
      args: [],
    };
  }

  if (command !== 'news-ingest' && command !== 'stock-sync') {
    throw new Error(`Unknown command: ${command}`);
  }

  return {
    command,
    args,
  };
};

export class ServiceCli {
  public constructor(private readonly services: IServiceCompositionRoot) {}

  public async run(argv: readonly string[]): Promise<IServiceCliRunResult> {
    const parsed = parseCommand(argv);

    if (parsed.command === 'help') {
      return createHelpResult(HELP_TEXT);
    }

    const options = parseOptions(parsed.args);

    if (parsed.command === 'news-ingest') {
      const request = parseNewsIngestRequest(options);
      const result = await this.services.newsIngestService.execute(request);
      return toCliRunResult('news-ingest', result);
    }

    const request = parseStockSyncRequest(options);
    const result = await this.services.stockSyncService.execute(request);
    return toCliRunResult('stock-sync', result);
  }
}

export const createServiceCli = (services: IServiceCompositionRoot = createServiceCompositionRoot()): ServiceCli => {
  return new ServiceCli(services);
};
