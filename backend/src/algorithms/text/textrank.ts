import { Graph } from '../../data-structures/graph.js';

export interface TextRankOptions {
  readonly dampingFactor?: number;
  readonly convergenceThreshold?: number;
  readonly maxIterations?: number;
  readonly windowSize?: number;
}

export interface TextRankKeyword {
  readonly term: string;
  readonly score: number;
}

export interface TextRankResult {
  readonly keywords: readonly TextRankKeyword[];
  readonly iterations: number;
  readonly converged: boolean;
}

export class TextRank {
  private readonly dampingFactor: number;
  private readonly convergenceThreshold: number;
  private readonly maxIterations: number;
  private readonly windowSize: number;

  public constructor(options: TextRankOptions = {}) {
    this.dampingFactor = options.dampingFactor ?? 0.85;
    this.convergenceThreshold = options.convergenceThreshold ?? 0.0001;
    this.maxIterations = options.maxIterations ?? 100;
    this.windowSize = options.windowSize ?? 4;
  }

  public rank(tokens: readonly string[]): TextRankResult {
    const filteredTokens = tokens.filter(token => token.trim().length > 0);

    if (filteredTokens.length === 0) {
      return {
        keywords: [],
        iterations: 0,
        converged: true,
      };
    }

    const graph = this.buildGraph(filteredTokens);
    const vertices = graph.getVertices();
    let scores = new Map<string, number>(vertices.map(vertex => [vertex, 1]));
    let converged = false;
    let iterations = 0;

    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      const nextScores = new Map<string, number>();
      let maxDelta = 0;

      for (const vertex of vertices) {
        const incomingScore = this.sumIncomingContributions(graph, vertex, scores, vertices);
        const nextScore = (1 - this.dampingFactor) + this.dampingFactor * incomingScore;
        nextScores.set(vertex, nextScore);
        maxDelta = Math.max(maxDelta, Math.abs(nextScore - (scores.get(vertex) ?? 0)));
      }

      scores = nextScores;
      iterations = iteration;

      if (maxDelta <= this.convergenceThreshold) {
        converged = true;
        break;
      }
    }

    const keywords = Array.from(scores.entries())
      .map(([term, score]) => ({ term, score }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.term.localeCompare(right.term);
      });

    return {
      keywords,
      iterations,
      converged,
    };
  }

  private buildGraph(tokens: readonly string[]): Graph<string> {
    const graph = new Graph<string>();

    for (const token of tokens) {
      graph.addVertex(token);
    }

    for (let index = 0; index < tokens.length; index += 1) {
      const limit = Math.min(tokens.length, index + this.windowSize);

      for (let neighborIndex = index + 1; neighborIndex < limit; neighborIndex += 1) {
        const from = tokens[index];
        const to = tokens[neighborIndex];

        if (from !== to) {
          graph.addEdge(from, to).addEdge(to, from);
        }
      }
    }

    return graph;
  }

  private sumIncomingContributions(
    graph: Graph<string>,
    target: string,
    scores: ReadonlyMap<string, number>,
    vertices: readonly string[],
  ): number {
    let total = 0;

    for (const source of vertices) {
      if (!graph.hasEdge(source, target)) {
        continue;
      }

      const outgoingCount = graph.getNeighbors(source).length;

      if (outgoingCount > 0) {
        total += (scores.get(source) ?? 0) / outgoingCount;
      }
    }

    return total;
  }
}
