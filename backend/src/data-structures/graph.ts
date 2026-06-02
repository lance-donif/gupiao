export interface GraphOptions {
  readonly allowSelfLoops?: boolean;
}

export interface GraphTraversalResult<TVertex> {
  readonly order: readonly TVertex[];
  readonly visited: ReadonlySet<TVertex>;
}

export interface GraphStats {
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly allowSelfLoops: boolean;
}

export class Graph<TVertex> {
  private readonly adjacencyMap = new Map<TVertex, Set<TVertex>>();
  private edgeCountValue = 0;

  public constructor(private readonly options: GraphOptions = {}) {}

  public get allowSelfLoops(): boolean {
    return this.options.allowSelfLoops ?? false;
  }

  public get vertexCount(): number {
    return this.adjacencyMap.size;
  }

  public get edgeCount(): number {
    return this.edgeCountValue;
  }

  public addVertex(vertex: TVertex): this {
    if (!this.adjacencyMap.has(vertex)) {
      this.adjacencyMap.set(vertex, new Set<TVertex>());
    }

    return this;
  }

  public addEdge(from: TVertex, to: TVertex): this {
    if (!this.allowSelfLoops && from === to) {
      throw new Error('self loops are disabled');
    }

    this.addVertex(from);
    this.addVertex(to);

    const neighbors = this.adjacencyMap.get(from);

    if (neighbors === undefined) {
      throw new Error('vertex adjacency list was not initialized');
    }

    if (!neighbors.has(to)) {
      neighbors.add(to);
      this.edgeCountValue += 1;
    }

    return this;
  }

  public hasVertex(vertex: TVertex): boolean {
    return this.adjacencyMap.has(vertex);
  }

  public hasEdge(from: TVertex, to: TVertex): boolean {
    return this.adjacencyMap.get(from)?.has(to) ?? false;
  }

  public getNeighbors(vertex: TVertex): readonly TVertex[] {
    return Array.from(this.requireVertex(vertex));
  }

  public getVertices(): readonly TVertex[] {
    return Array.from(this.adjacencyMap.keys());
  }

  public bfs(start: TVertex): GraphTraversalResult<TVertex> {
    return this.traverseBreadthFirst(start);
  }

  public dfs(start: TVertex): GraphTraversalResult<TVertex> {
    this.requireVertex(start);

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

      const neighbors = Array.from(this.requireVertex(vertex));

      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighbor = neighbors[index];

        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    return { order, visited };
  }

  public bfsAll(): GraphTraversalResult<TVertex> {
    return this.traverseAllVertices((vertex, visited, order) => {
      const queue: TVertex[] = [vertex];
      visited.add(vertex);

      while (queue.length > 0) {
        const current = queue.shift();

        if (current === undefined) {
          continue;
        }

        order.push(current);

        for (const neighbor of this.requireVertex(current)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    });
  }

  public dfsAll(): GraphTraversalResult<TVertex> {
    return this.traverseAllVertices((vertex, visited, order) => {
      const stack: TVertex[] = [vertex];

      while (stack.length > 0) {
        const current = stack.pop();

        if (current === undefined || visited.has(current)) {
          continue;
        }

        visited.add(current);
        order.push(current);

        const neighbors = Array.from(this.requireVertex(current));

        for (let index = neighbors.length - 1; index >= 0; index -= 1) {
          const neighbor = neighbors[index];

          if (!visited.has(neighbor)) {
            stack.push(neighbor);
          }
        }
      }
    });
  }

  public getStats(): GraphStats {
    return {
      vertexCount: this.vertexCount,
      edgeCount: this.edgeCount,
      allowSelfLoops: this.allowSelfLoops,
    };
  }

  private traverseBreadthFirst(start: TVertex): GraphTraversalResult<TVertex> {
    this.requireVertex(start);

    const visited = new Set<TVertex>([start]);
    const order: TVertex[] = [];
    const queue: TVertex[] = [start];
    let head = 0;

    while (head < queue.length) {
      const vertex = queue[head];
      head += 1;

      order.push(vertex);

      for (const neighbor of this.requireVertex(vertex)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    return { order, visited };
  }

  private traverseAllVertices(
    visitComponent: (
      vertex: TVertex,
      visited: Set<TVertex>,
      order: TVertex[],
    ) => void,
  ): GraphTraversalResult<TVertex> {
    const visited = new Set<TVertex>();
    const order: TVertex[] = [];

    for (const vertex of this.adjacencyMap.keys()) {
      if (!visited.has(vertex)) {
        visitComponent(vertex, visited, order);
      }
    }

    return { order, visited };
  }

  private requireVertex(vertex: TVertex): Set<TVertex> {
    const neighbors = this.adjacencyMap.get(vertex);

    if (neighbors === undefined) {
      throw new Error('vertex does not exist');
    }

    return neighbors;
  }
}
