import path from 'node:path';

import { createBackendIntegrationConfig } from '../src/services/integration-config.js';
import { FriendNetworkAgeGraphReadClient, PgAgeGraphClient } from '../src/repositories/friend-network-graph-repository.js';
import { FriendNetworkQueryService } from '../src/services/friend-network-query-service.js';

async function main(): Promise<void> {
  const config = createBackendIntegrationConfig();
  const cluster = process.argv[2] ?? 'friend-network-cluster';
  const keyword = process.argv[3] ?? '白银';
  void path.resolve(cluster);

  const baseClient = new PgAgeGraphClient(config.databaseUrl, 'friend_network');
  const queryService = new FriendNetworkQueryService(new FriendNetworkAgeGraphReadClient(baseClient));

  const [summary, nodes, neighbors, weakSignals] = await Promise.all([
    queryService.querySummary(cluster),
    queryService.queryNodes(cluster),
    queryService.queryNeighbors(cluster, keyword),
    queryService.queryWeakSignals(cluster),
  ]);

  console.log(JSON.stringify({
    summary,
    topNodes: nodes.slice(0, 10),
    keyword,
    neighbors,
    weakSignals: weakSignals.slice(0, 10),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
