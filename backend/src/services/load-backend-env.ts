import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

export const loadBackendEnv = (): void => {
  const rootEnvPath = path.resolve(process.cwd(), '..', '.env');
  if (existsSync(rootEnvPath)) {
    config({ path: rootEnvPath, override: false });
  }

  const backendEnvPath = path.resolve(process.cwd(), '.env');
  if (existsSync(backendEnvPath)) {
    config({ path: backendEnvPath, override: false });
  }
};
