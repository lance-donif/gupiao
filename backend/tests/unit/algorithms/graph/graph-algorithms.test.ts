import { describe, expect, it } from 'vitest';

import {
  GraphBreadthFirstSearch,
  GraphDepthFirstSearch,
  PageRank,
  ShortestPath,
} from '../../../../src/algorithms/graph/index.js';
import { Graph } from '../../../../src/data-structures/graph.js';

describe('graph algorithms', () => {
  it('limits BFS traversal to reachable nodes within maxHops', () => {
    const graph = new Graph<string>();

    graph
      .addEdge('A', 'B')
      .addEdge('A', 'C')
      .addEdge('B', 'D')
      .addEdge('C', 'E')
      .addEdge('D', 'F')
      .addEdge('X', 'Y');

    const algorithm = new GraphBreadthFirstSearch<string>();
    const result = algorithm.traverse(graph, 'A', { maxHops: 2 });

    expect(result.order).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(Array.from(result.visited)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(result.depths).toEqual(
      new Map([
        ['A', 0],
        ['B', 1],
        ['C', 1],
        ['D', 2],
        ['E', 2],
      ]),
    );
  });

  it('handles cycles correctly during DFS without revisiting nodes', () => {
    const graph = new Graph<string>({ allowSelfLoops: true });

    graph
      .addEdge('A', 'B')
      .addEdge('A', 'C')
      .addEdge('B', 'D')
      .addEdge('D', 'A')
      .addEdge('C', 'C')
      .addEdge('C', 'E');

    const algorithm = new GraphDepthFirstSearch<string>();
    const result = algorithm.traverse(graph, 'A');

    expect(result.order).toEqual(['A', 'B', 'D', 'C', 'E']);
    expect(Array.from(result.visited)).toEqual(['A', 'B', 'D', 'C', 'E']);
  });

  it('normalizes PageRank scores so they sum to 1.0 and ranks central nodes higher', () => {
    const graph = new Graph<string>();

    graph
      .addEdge('A', 'B')
      .addEdge('A', 'C')
      .addEdge('B', 'C')
      .addEdge('C', 'A')
      .addVertex('D');

    const algorithm = new PageRank<string>({ maxIterations: 200, tolerance: 1e-9 });
    const result = algorithm.rank(graph);
    const total = Array.from(result.scores.values()).reduce((sum, score) => sum + score, 0);

    expect(total).toBeCloseTo(1, 10);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.converged).toBe(true);
    expect(result.scores.get('C') ?? 0).toBeGreaterThan(result.scores.get('D') ?? 0);
  });

  it('returns the correct unweighted shortest path distance and route', () => {
    const graph = new Graph<string>();

    graph
      .addEdge('A', 'B')
      .addEdge('A', 'C')
      .addEdge('B', 'D')
      .addEdge('C', 'D')
      .addEdge('D', 'E')
      .addEdge('B', 'F');

    const algorithm = new ShortestPath<string>();
    const result = algorithm.find(graph, 'A', 'E');

    expect(result.distance).toBe(3);
    expect(result.path).toEqual(['A', 'B', 'D', 'E']);
    expect(result.reachable).toBe(true);
  });

  it('returns Infinity distance when target is unreachable', () => {
    const graph = new Graph<string>();

    graph.addEdge('A', 'B').addVertex('Z');

    const algorithm = new ShortestPath<string>();
    const result = algorithm.find(graph, 'A', 'Z');

    expect(result.distance).toBe(Number.POSITIVE_INFINITY);
    expect(result.path).toEqual([]);
    expect(result.reachable).toBe(false);
  });
});
