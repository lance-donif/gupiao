import { describe, expect, it } from 'vitest';

import { Graph } from '../../../src/data-structures/graph.js';

describe('Graph', () => {
  it('stores vertices in an adjacency-list structure and enforces unique directed edges', () => {
    const graph = new Graph<string>();

    graph.addVertex('A').addVertex('B').addEdge('A', 'B').addEdge('A', 'B');

    expect(graph.hasVertex('A')).toBe(true);
    expect(graph.hasVertex('B')).toBe(true);
    expect(graph.hasEdge('A', 'B')).toBe(true);
    expect(graph.edgeCount).toBe(1);
    expect(graph.getNeighbors('A')).toEqual(['B']);
  });

  it('performs BFS in O(V+E)-style traversal order from the chosen start vertex', () => {
    const graph = new Graph<string>();

    graph
      .addEdge('A', 'B')
      .addEdge('A', 'C')
      .addEdge('B', 'D')
      .addEdge('C', 'E')
      .addEdge('D', 'F')
      .addEdge('E', 'F');

    const traversal = graph.bfs('A');

    expect(traversal.order).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(Array.from(traversal.visited)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('performs DFS iteratively and handles cycles without revisiting vertices', () => {
    const graph = new Graph<string>({ allowSelfLoops: true });

    graph
      .addEdge('A', 'B')
      .addEdge('A', 'C')
      .addEdge('B', 'D')
      .addEdge('D', 'A')
      .addEdge('C', 'C');

    const traversal = graph.dfs('A');

    expect(traversal.order).toEqual(['A', 'B', 'D', 'C']);
    expect(Array.from(traversal.visited)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('traverses disconnected components when using bfsAll and dfsAll', () => {
    const graph = new Graph<number>();

    graph.addEdge(1, 2).addEdge(2, 3).addVertex(4).addEdge(5, 6);

    expect(graph.bfsAll().order).toEqual([1, 2, 3, 4, 5, 6]);
    expect(graph.dfsAll().order).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects self loops by default and can allow them when configured', () => {
    const defaultGraph = new Graph<string>();

    expect(() => defaultGraph.addEdge('A', 'A')).toThrowError('self loops are disabled');

    const loopEnabledGraph = new Graph<string>({ allowSelfLoops: true });
    loopEnabledGraph.addEdge('A', 'A');

    expect(loopEnabledGraph.hasEdge('A', 'A')).toBe(true);
    expect(loopEnabledGraph.edgeCount).toBe(1);
    expect(loopEnabledGraph.getStats()).toEqual({
      vertexCount: 1,
      edgeCount: 1,
      allowSelfLoops: true,
    });
  });

  it('rejects traversals or neighbor lookups for vertices that do not exist', () => {
    const graph = new Graph<string>();

    graph.addVertex('existing');

    expect(() => graph.bfs('missing')).toThrowError('vertex does not exist');
    expect(() => graph.dfs('missing')).toThrowError('vertex does not exist');
    expect(() => graph.getNeighbors('missing')).toThrowError('vertex does not exist');
  });
});
