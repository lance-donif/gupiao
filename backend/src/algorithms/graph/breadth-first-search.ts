import type { Graph, GraphTraversalResult } from '../../data-structures/graph.js';

export interface GraphBreadthFirstSearchOptions {
  readonly maxHops?: number;
}

export interface GraphBreadthFirstSearchResult<TVertex>
  extends GraphTraversalResult<TVertex> {
  readonly depths: ReadonlyMap<TVertex, number>;
}

export class GraphBreadthFirstSearch<TVertex> {
  public traverse(
    graph: Graph<TVertex>,
    start: TVertex,
    options: GraphBreadthFirstSearchOptions = {},
  ): GraphBreadthFirstSearchResult<TVertex> {
    const maxHops = options.maxHops ?? Number.POSITIVE_INFINITY;

    if (maxHops < 0) {
      throw new Error('maxHops must be greater than or equal to 0');
    }

    graph.getNeighbors(start);

    const visited = new Set<TVertex>([start]);
    const order: TVertex[] = [];
    const depths = new Map<TVertex, number>([[start, 0]]);
    const queue: TVertex[] = [start];
    let head = 0;

    while (head < queue.length) {
      const vertex = queue[head];
      head += 1;

      order.push(vertex);

      const depth = depths.get(vertex) ?? 0;

      if (depth >= maxHops) {
        continue;
      }

      for (const neighbor of graph.getNeighbors(vertex)) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        depths.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
    }

    return { order, visited, depths };
  }
}
