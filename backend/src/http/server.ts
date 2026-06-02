import path from 'node:path';

import { loadBackendEnv } from '../services/load-backend-env.js';
import { FileBackedConfigStore } from './config-store.js';
import { startBackendHttpServer } from './index.js';

export const resolveRootDir = (input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
} = {}): string => {
  return path.resolve(input.env?.BACKEND_ROOT_DIR ?? process.env.BACKEND_ROOT_DIR ?? input.cwd ?? process.cwd());
};

async function main(): Promise<void> {
  loadBackendEnv();
  const port = Number(process.env.PORT ?? '8787');
  const host = process.env.HOST ?? '127.0.0.1';
  const rootDir = resolveRootDir();
  const server = await startBackendHttpServer({
    rootDir,
    configStore: new FileBackedConfigStore(path.join(rootDir, 'tmp', 'http-runtime', 'config')),
    port,
    host,
  });
  console.log(`backend http shell listening on http://${host}:${server.port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
