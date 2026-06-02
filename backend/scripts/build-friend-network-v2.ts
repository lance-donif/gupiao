import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createStubFriendNetworkAiAdapter,
  type IFriendNetworkAiAdapter,
} from '../src/services/friend-network-ai-adapter.js';
import { createFriendNetworkEngine } from '../src/services/friend-network-engine.js';
import { createFriendNetworkLlmAiAdapterFromEnv } from '../src/services/friend-network-llm-ai-adapter.js';
import type { IFriendNetworkEngineInput } from '../src/services/friend-network-types.js';
import type { IRawNewsFilePayload } from './build-friend-network.js';

interface IBuildFriendNetworkSnapshotInput {
  readonly sourceNewsFilePath: string;
  readonly cluster: string;
  readonly payload: IRawNewsFilePayload;
  readonly createAiAdapter?: () => IFriendNetworkAiAdapter;
  readonly createStubAiAdapter?: () => IFriendNetworkAiAdapter;
}

const resolveAiAdapter = (input: IBuildFriendNetworkSnapshotInput): IFriendNetworkAiAdapter => {
  const createAiAdapter = input.createAiAdapter ?? createFriendNetworkLlmAiAdapterFromEnv;
  const createStubAiAdapter = input.createStubAiAdapter ?? createStubFriendNetworkAiAdapter;

  try {
    return createAiAdapter();
  } catch {
    return createStubAiAdapter();
  }
};

const toBeijingTime = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
};

export const buildFriendNetworkSnapshot = async (input: IBuildFriendNetworkSnapshotInput) => {
  const engine = createFriendNetworkEngine({
    aiAdapter: resolveAiAdapter(input),
  });
  const engineInput: IFriendNetworkEngineInput = {
    cluster: input.cluster,
    sourceNewsFilePath: input.sourceNewsFilePath,
    asOf: new Date(),
    newsItems: (input.payload.rawNews ?? []).map((item) => ({
      ...item,
      source: 'temp-news',
    })),
  };

  const result = await engine.run(engineInput);
  return {
    generatedAtBeijing: toBeijingTime(new Date().toISOString()),
    sourceNewsFilePath: input.sourceNewsFilePath,
    graph: result.graph,
    tree: result.tree,
    aiDecisions: result.aiDecisions,
  };
};

const resolveTmpDirectory = (): string => path.resolve(process.cwd(), 'tmp');

const resolveNewsFilePath = async (): Promise<string> => {
  const candidateDirectories = [path.resolve(process.cwd(), 'backend', 'tmp'), resolveTmpDirectory()];
  for (const directory of candidateDirectories) {
    try {
      const files = (await readdir(directory)).filter((file) => file.includes('raw-news') && file.endsWith('.json')).sort().reverse();
      if (files.length > 0) return path.join(directory, files[0] as string);
    } catch {
      continue;
    }
  }
  throw new Error('未找到新闻临时文件');
};

async function main(): Promise<void> {
  const sourceNewsFilePath = process.argv[2] ? path.resolve(process.argv[2]) : await resolveNewsFilePath();
  const payload = JSON.parse(await readFile(sourceNewsFilePath, 'utf8')) as IRawNewsFilePayload;
  const snapshot = await buildFriendNetworkSnapshot({
    sourceNewsFilePath,
    cluster: 'friend-network-cluster',
    payload,
  });

  const outputDirectory = resolveTmpDirectory();
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `friend-network-v2-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`已输出到: ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
