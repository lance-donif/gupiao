import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createBackendIntegrationConfig } from '../src/services/integration-config.js';
import { createFriendNetworkEngine } from '../src/services/friend-network-engine.js';
import { createStubFriendNetworkAiAdapter } from '../src/services/friend-network-ai-adapter.js';
import { createFriendNetworkLlmAiAdapterFromEnv } from '../src/services/friend-network-llm-ai-adapter.js';
import type { IFriendNetworkEngineInput } from '../src/services/friend-network-types.js';
import { FriendNetworkGraphRepository, PgAgeGraphClient } from '../src/repositories/friend-network-graph-repository.js';
import type { IRawNewsFilePayload } from './build-friend-network.js';

export interface IBuildFriendNetworkPgInput {
  readonly sourceNewsFilePath: string;
  readonly cluster: string;
  readonly asOf?: Date;
}

export const buildFriendNetworkToPg = async (input: IBuildFriendNetworkPgInput) => {
  const config = createBackendIntegrationConfig();
  const graphClient = new PgAgeGraphClient(config.databaseUrl, 'friend_network');
  const graphRepository = new FriendNetworkGraphRepository(graphClient);
  const aiAdapter = (() => {
    try {
      return createFriendNetworkLlmAiAdapterFromEnv();
    } catch {
      return createStubFriendNetworkAiAdapter();
    }
  })();
  const engine = createFriendNetworkEngine({ graphRepository, aiAdapter });

  const payload = JSON.parse(await readFile(input.sourceNewsFilePath, 'utf8')) as IRawNewsFilePayload;
  const engineInput: IFriendNetworkEngineInput = {
    cluster: input.cluster,
    sourceNewsFilePath: input.sourceNewsFilePath,
    asOf: input.asOf ?? new Date(),
    newsItems: (payload.rawNews ?? []).map((item) => ({
      ...item,
      source: 'temp-news',
    })),
  };

  try {
    return await engine.run(engineInput);
  } catch (error) {
    if (
      error instanceof Error
      && (error.message.includes('Friend network AI request failed')
        || error.message.includes('Unexpected token')
        || error.message.includes('JSON'))
    ) {
      const fallbackEngine = createFriendNetworkEngine({
        graphRepository,
        aiAdapter: createStubFriendNetworkAiAdapter(),
      });
      return fallbackEngine.run(engineInput);
    }

    throw error;
  }
};

async function main(): Promise<void> {
  const sourceNewsFilePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(process.cwd(), 'tmp', 'raw-news-latest.json');
  const cluster = process.argv[3] ?? 'friend-network-cluster';
  const result = await buildFriendNetworkToPg({
    sourceNewsFilePath,
    cluster,
  });

  console.log(JSON.stringify({
    cluster,
    graphNodes: result.graph.nodes.length,
    graphRelationships: result.graph.relationships.length,
    persisted: result.persistence,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
