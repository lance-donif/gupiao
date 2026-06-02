import type { Graph } from '../../data-structures/graph.js';

export interface ShortestPathResult<TVertex> {
  readonly distance: number;
  readonly path: readonly TVertex[];
  readonly reachable: boolean;
}

export class ShortestPath<TVertex> {
  public find(
    graph: Graph<TVertex>,
    start: TVertex,
    target: TVertex,
  ): ShortestPathResult<TVertex> {
    graph.getNeighbors(start);
    graph.getNeighbors(target);

    if (start === target) {
      return {
        distance: 0,
        path: [start],
        reachable: true,
      };
    }

    const queue: TVertex[] = [start];
    const visited = new Set<TVertex>([start]);
    const distances = new Map<TVertex, number>([[start, 0]]);
    const predecessors = new Map<TVertex, TVertex>();
    let head = 0;

    while (head < queue.length) {
      const vertex = queue[head];
      head += 1;
      const distance = distances.get(vertex) ?? 0;

      for (const neighbor of graph.getNeighbors(vertex)) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        distances.set(neighbor, distance + 1);
        predecessors.set(neighbor, vertex);

        if (neighbor === target) {
          return {
            distance: distance + 1,
            path: this.buildPath(predecessors, start, target),
            reachable: true,
          };
        }

        queue.push(neighbor);
      }
    }

    return {
      distance: Number.POSITIVE_INFINITY,
      path: [],
      reachable: false,
    };
  }

  private buildPath(
    predecessors: ReadonlyMap<TVertex, TVertex>,
    start: TVertex,
    target: TVertex,
  ): TVertex[] {
    const path: TVertex[] = [target];
    let current = target;

    while (current !== start) {
      const predecessor = predecessors.get(current);

      if (predecessor === undefined) {
        return [];
      }

      path.push(predecessor);
      current = predecessor;
    }

    path.reverse();
    return path;
  }
}
