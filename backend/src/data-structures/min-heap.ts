export type MinHeapComparator<TValue> = (left: TValue, right: TValue) => number;

export interface MinHeapOptions<TValue> {
  readonly compare: MinHeapComparator<TValue>;
}

export interface MinHeapStats {
  readonly size: number;
  readonly isEmpty: boolean;
  readonly lastLevelSize: number;
  readonly height: number;
}

export class MinHeap<TValue> {
  private readonly heap: TValue[] = [];

  public constructor(private readonly options: MinHeapOptions<TValue>) {
    MinHeap.ensureComparator(options.compare);
  }

  public get size(): number {
    return this.heap.length;
  }

  public get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  public insert(value: TValue): void {
    this.heap.push(value);
    this.siftUp(this.heap.length - 1);
  }

  public peek(): TValue | undefined {
    return this.heap[0];
  }

  public extractMin(): TValue | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }

    const root = this.heap[0];
    const tail = this.heap.pop();

    if (tail === undefined) {
      return undefined;
    }

    if (this.heap.length > 0) {
      this.heap[0] = tail;
      this.siftDown(0);
    }

    return root;
  }

  public clear(): void {
    this.heap.length = 0;
  }

  public toArray(): readonly TValue[] {
    return [...this.heap];
  }

  public getStats(): MinHeapStats {
    const size = this.size;

    if (size === 0) {
      return {
        size: 0,
        isEmpty: true,
        lastLevelSize: 0,
        height: 0,
      };
    }

    const height = Math.floor(Math.log2(size)) + 1;
    const nodesBeforeLastLevel = 2 ** (height - 1) - 1;

    return {
      size,
      isEmpty: false,
      lastLevelSize: size - nodesBeforeLastLevel,
      height,
    };
  }

  private siftUp(startIndex: number): void {
    let childIndex = startIndex;

    while (childIndex > 0) {
      const parentIndex = this.getParentIndex(childIndex);

      if (this.compareAt(childIndex, parentIndex) >= 0) {
        break;
      }

      this.swap(childIndex, parentIndex);
      childIndex = parentIndex;
    }
  }

  private siftDown(startIndex: number): void {
    let parentIndex = startIndex;

    while (true) {
      const leftChildIndex = this.getLeftChildIndex(parentIndex);

      if (leftChildIndex >= this.heap.length) {
        return;
      }

      const rightChildIndex = leftChildIndex + 1;
      let candidateIndex = leftChildIndex;

      if (
        rightChildIndex < this.heap.length
        && this.compareAt(rightChildIndex, leftChildIndex) < 0
      ) {
        candidateIndex = rightChildIndex;
      }

      if (this.compareAt(candidateIndex, parentIndex) >= 0) {
        return;
      }

      this.swap(parentIndex, candidateIndex);
      parentIndex = candidateIndex;
    }
  }

  private compareAt(leftIndex: number, rightIndex: number): number {
    return this.options.compare(this.heap[leftIndex], this.heap[rightIndex]);
  }

  private swap(leftIndex: number, rightIndex: number): void {
    const temporary = this.heap[leftIndex];
    this.heap[leftIndex] = this.heap[rightIndex];
    this.heap[rightIndex] = temporary;
  }

  private getParentIndex(index: number): number {
    return Math.floor((index - 1) / 2);
  }

  private getLeftChildIndex(index: number): number {
    return index * 2 + 1;
  }

  private static ensureComparator<TValue>(
    comparator: MinHeapComparator<TValue> | undefined,
  ): asserts comparator is MinHeapComparator<TValue> {
    if (typeof comparator !== 'function') {
      throw new Error('compare must be a function');
    }
  }
}
