import { createBackendIntegrationConfig } from '../src/services/integration-config.js';
import { buildDeleteClusterGraphCypher, PgAgeGraphClient } from '../src/repositories/friend-network-graph-repository.js';

async function main(): Promise<void> {
  const config = createBackendIntegrationConfig();
  const cluster = process.argv[2] ?? 'cluster-news-debug';
  const client = new PgAgeGraphClient(config.databaseUrl, 'friend_network');

  for (const cypher of buildDeleteClusterGraphCypher(cluster)) {
    await client.execute(cypher);
  }

  console.log(JSON.stringify({
    cluster,
    cleaned: true,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
