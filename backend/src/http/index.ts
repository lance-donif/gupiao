import type { IRuntimeServerOptions } from './runtime-types.js';

import type { IBackendConfigStore, IContributionDetailReader, IDailyReportSnapshotReader } from './types.js';
import { createServer } from 'node:http';
import { FileBackedConfigStore } from './config-store.js';
import { createContributionDetailReader } from './contribution-reader.js';
import { createDailyReportSnapshotReader } from './daily-report-reader.js';
import { writeJson } from './http-utils.js';
import { handleBackendRoute } from './routes.js';
import { BackendRuntimeStore } from './runtime-store.js';

export { BackendRuntimeStore, createBackendRuntimeStore } from './runtime-store.js';
export type { IBackendArtifacts, IBackendConfigStore, IContributionDetailReader, IDailyReportSnapshotReader } from './types.js';

export const startBackendHttpServer = async (
  options: IRuntimeServerOptions & {
    rootDir: string;
    configStore: IBackendConfigStore;
    contributionReader?: IContributionDetailReader;
    dailyReportReader?: IDailyReportSnapshotReader | null;
  },
): Promise<{ close: () => Promise<void>; port: number }> => {
  const host = options.host ?? '127.0.0.1';
  const contributionReader = options.contributionReader ?? await createContributionDetailReader(process.env.DATABASE_URL);
  const dailyReportReader = options.dailyReportReader === null
    ? undefined
    : options.dailyReportReader ?? await createDailyReportSnapshotReader(process.env.DATABASE_URL);
  let pgPool: { query: <T>(sql: string, values?: readonly unknown[]) => Promise<{ rows: readonly T[] }>; end: () => Promise<void> } | undefined;
  if (process.env.DATABASE_URL) {
    const pgModule = await import('pg') as unknown as { Pool: new (opts: { connectionString: string }) => typeof pgPool };
    pgPool = new pgModule.Pool({ connectionString: process.env.DATABASE_URL });
  }
  const runtimeStore = new BackendRuntimeStore({
    rootDir: options.rootDir,
    configStore: options.configStore,
    contributionReader,
    dailyReportReader,
    pgPool,
  });

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const startedAt = Date.now();
      let ok = false;
      try {
        const result = await handleBackendRoute(request, response, runtimeStore, host);
        ok = result.ok;
        if (!result.handled) {
          writeJson(response, 404, { detail: 'not found' });
        }
      }
      catch (error) {
        writeJson(response, 500, { detail: error instanceof Error ? error.message : String(error) });
      }
      finally {
        const url = new URL(request.url ?? '/', `http://${host}`);
        await runtimeStore.recordEndpointRequest({
          method: request.method ?? 'GET',
          path: url.pathname,
          duration_ms: Date.now() - startedAt,
          ok,
        });
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port ?? 0;
  return {
    port,
    close: async () => {
      if (contributionReader && 'close' in contributionReader && typeof contributionReader.close === 'function') {
        await contributionReader.close();
      }
      if (dailyReportReader && 'close' in dailyReportReader && typeof dailyReportReader.close === 'function') {
        await dailyReportReader.close();
      }
      if (pgPool) {
        await pgPool.end();
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (giveUpTimer) {
            clearTimeout(giveUpTimer);
          }
          resolve();
        };
        server.closeAllConnections();
        server.closeIdleConnections();
        giveUpTimer = setTimeout(finish, 250);
        server.close((error) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
              finish();
              return;
            }
            if (giveUpTimer) {
              clearTimeout(giveUpTimer);
            }
            reject(error);
            return;
          }
          finish();
        });
      });
    },
  };
};

export const createDefaultConfigStore = (rootDir: string): FileBackedConfigStore => {
  return new FileBackedConfigStore(`${rootDir}/tmp/http-runtime/config`);
};
