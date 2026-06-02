import type { Graph, GraphTraversalResult } from '../../data-structures/graph.js';

export class GraphDepthFirstSearch<TVertex> {
  public traverse(
    graph: Graph<TVertex>,
    start: TVertex,
  ): GraphTraversalResult<TVertex> {
    graph.getNeighbors(start);

    const visited = new Set<TVertex>();
    const order: TVertex[] = [];
    const stack: TVertex[] = [start];

    while (stack.length > 0) {
      const vertex = stack.pop();

      if (vertex === undefined || visited.has(vertex)) {
        continue;
      }

      visited.add(vertex);
      order.push(vertex);

      const neighbors = graph.getNeighbors(vertex);

      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighbor = neighbors[index];

        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    return { order, visited };
  }
}
