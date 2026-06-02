import type { BackendConfigCategory, IBackendConfigItem, IBackendConfigStore } from './types.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';

type ConfigFileShape = Record<string, string>;

const DEFAULT_CONFIG: Record<BackendConfigCategory, ConfigFileShape> = {
  ai: {
    'ai.model': 'deepseek-chat',
    'ai.provider': 'builtin-runtime',
  },
  akshare: {
    'akshare.enabled': 'false',
  },
  strategy: {
    'strategy.max_depth': '3',
    'strategy.max_nodes': '200',
  },
  system: {
    'system.backend_http_port': '8000',
    'system.runtime_store': 'file-backed',
  },
};

const CONFIG_LABELS: Record<string, string> = {
  'ai.model': 'AI 模型',
  'ai.provider': 'AI Provider',
  'akshare.enabled': 'AKShare 开关',
  'strategy.max_depth': '图谱最大深度',
  'strategy.max_nodes': '图谱最大节点数',
  'system.backend_http_port': 'HTTP 端口',
  'system.runtime_store': 'Runtime Store 模式',
};

const CONFIG_SECRETS = new Set<string>();

export class FileBackedConfigStore implements IBackendConfigStore {
  public constructor(private readonly configDir: string) {}

  public async listByCategory(category: BackendConfigCategory): Promise<readonly IBackendConfigItem[]> {
    const values = await this.readCategory(category);
    return Object.entries(values).map(([key, value]) => ({
      key,
      value,
      category,
      label: CONFIG_LABELS[key] ?? key,
      is_secret: CONFIG_SECRETS.has(key),
    }));
  }

  public async setValue(key: string, value: string): Promise<{ key: string; value: string; message: string }> {
    const category = this.resolveCategory(key);
    const values = await this.readCategory(category);
    values[key] = value;
    await this.writeCategory(category, values);
    return {
      key,
      value,
      message: 'updated',
    };
  }

  private resolveCategory(key: string): BackendConfigCategory {
    const category = key.split('.')[0] as BackendConfigCategory;
    if (category === 'ai' || category === 'akshare' || category === 'strategy' || category === 'system') {
      return category;
    }
    return 'system';
  }

  private resolveFilePath(category: BackendConfigCategory): string {
    return path.join(this.configDir, `${category}.json`);
  }

  private async readCategory(category: BackendConfigCategory): Promise<ConfigFileShape> {
    await mkdir(this.configDir, { recursive: true });
    const filePath = this.resolveFilePath(category);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ...DEFAULT_CONFIG[category] };
      }
      return {
        ...DEFAULT_CONFIG[category],
        ...(parsed as ConfigFileShape),
      };
    }
    catch {
      const fallback = { ...DEFAULT_CONFIG[category] };
      await this.writeCategory(category, fallback);
      return fallback;
    }
  }

  private async writeCategory(category: BackendConfigCategory, values: ConfigFileShape): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.resolveFilePath(category), `${JSON.stringify(values, null, 2)}\n`, 'utf8');
  }
}
