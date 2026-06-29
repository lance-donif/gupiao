import { pathToFileURL } from 'node:url';

import { loadBackendEnv } from '../src/services/load-backend-env.js';
import { runSchedulerLoop } from '../src/services/mvp-daily-scheduler.js';

loadBackendEnv();

const abortController = new AbortController();
const shutdown = (signal: NodeJS.Signals): void => {
  console.log(`[scheduler] received ${signal}, shutting down...`);
  abortController.abort();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<void> {
  await runSchedulerLoop({ signal: abortController.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
