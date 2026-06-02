import type { Graph } from '../../data-structures/graph.js';

export interface PageRankOptions {
  readonly dampingFactor?: number;
  readonly tolerance?: number;
  readonly maxIterations?: number;
}

export interface PageRankResult<TVertex> {
  readonly scores: ReadonlyMap<TVertex, number>;
  readonly iterations: number;
  readonly converged: boolean;
}

export class PageRank<TVertex> {
  private readonly dampingFactor: number;
  private readonly tolerance: number;
  private readonly maxIterations: number;

  public constructor(options: PageRankOptions = {}) {
    this.dampingFactor = options.dampingFactor ?? 0.85;
    this.tolerance = options.tolerance ?? 0.000001;
    this.maxIterations = options.maxIterations ?? 100;

    if (this.dampingFactor <= 0 || this.dampingFactor >= 1) {
      throw new Error('dampingFactor must be between 0 and 1');
    }

    if (this.tolerance <= 0) {
      throw new Error('tolerance must be greater than 0');
    }

    if (this.maxIterations <= 0) {
      throw new Error('maxIterations must be greater than 0');
    }
  }

  public rank(graph: Graph<TVertex>): PageRankResult<TVertex> {
    const vertices = graph.getVertices();
    const vertexCount = vertices.length;

    if (vertexCount === 0) {
      return {
        scores: new Map<TVertex, number>(),
        iterations: 0,
        converged: true,
      };
    }

    let scores = new Map<TVertex, number>(
      vertices.map(vertex => [vertex, 1 / vertexCount]),
    );
    let iterations = 0;
    let converged = false;

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      const danglingMass = this.computeDanglingMass(graph, vertices, scores);
      const nextScores = new Map<TVertex, number>();
      let maxDelta = 0;

      for (const vertex of vertices) {
        const incomingContribution = this.sumIncomingContributions(
          graph,
          vertex,
          vertices,
          scores,
        );
        const teleportation = (1 - this.dampingFactor) / vertexCount;
        const danglingContribution = (this.dampingFactor * danglingMass) / vertexCount;
        const score
          = teleportation + danglingContribution + this.dampingFactor * incomingContribution;

        nextScores.set(vertex, score);
        maxDelta = Math.max(maxDelta, Math.abs(score - (scores.get(vertex) ?? 0)));
      }

      scores = this.normalizeScores(nextScores, vertices);
      iterations = iteration;

      if (maxDelta <= this.tolerance) {
        converged = true;
        break;
      }
    }

    return {
      scores,
      iterations,
      converged,
    };
  }

  private computeDanglingMass(
    graph: Graph<TVertex>,
    vertices: readonly TVertex[],
    scores: ReadonlyMap<TVertex, number>,
  ): number {
    let danglingMass = 0;

    for (const vertex of vertices) {
      if (graph.getNeighbors(vertex).length === 0) {
        danglingMass += scores.get(vertex) ?? 0;
      }
    }

    return danglingMass;
  }

  private sumIncomingContributions(
    graph: Graph<TVertex>,
    target: TVertex,
    vertices: readonly TVertex[],
    scores: ReadonlyMap<TVertex, number>,
  ): number {
    let total = 0;

    for (const source of vertices) {
      if (!graph.hasEdge(source, target)) {
        continue;
      }

      const outDegree = graph.getNeighbors(source).length;

      if (outDegree > 0) {
        total += (scores.get(source) ?? 0) / outDegree;
      }
    }

    return total;
  }

  private normalizeScores(
    scores: ReadonlyMap<TVertex, number>,
    vertices: readonly TVertex[],
  ): Map<TVertex, number> {
    const total = Array.from(scores.values()).reduce((sum, score) => sum + score, 0);

    if (total === 0) {
      return new Map(vertices.map(vertex => [vertex, 1 / vertices.length]));
    }

    return new Map(vertices.map(vertex => [vertex, (scores.get(vertex) ?? 0) / total]));
  }
}
