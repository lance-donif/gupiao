export interface RingBufferStats {
  readonly capacity: number;
  readonly size: number;
  readonly isFull: boolean;
  readonly oldestIndex: number | null;
  readonly newestIndex: number | null;
}

export class RingBuffer<TValue> {
  private readonly storage: Array<TValue | undefined>;
  private head = 0;
  private sizeValue = 0;

  public constructor(private readonly capacityValue: number) {
    RingBuffer.ensurePositiveInteger(capacityValue, 'capacity');
    this.storage = new Array<TValue | undefined>(capacityValue);
  }

  public get capacity(): number {
    return this.capacityValue;
  }

  public get size(): number {
    return this.sizeValue;
  }

  public get isEmpty(): boolean {
    return this.sizeValue === 0;
  }

  public get isFull(): boolean {
    return this.sizeValue === this.capacityValue;
  }

  public push(value: TValue): void {
    const writeIndex = this.getWriteIndex();
    this.storage[writeIndex] = value;

    if (this.isFull) {
      this.head = (this.head + 1) % this.capacityValue;
      return;
    }

    this.sizeValue += 1;
  }

  public peekOldest(): TValue | undefined {
    if (this.isEmpty) {
      return undefined;
    }

    return this.storage[this.head];
  }

  public peekNewest(): TValue | undefined {
    if (this.isEmpty) {
      return undefined;
    }

    const newestIndex = (this.head + this.sizeValue - 1) % this.capacityValue;
    return this.storage[newestIndex];
  }

  public at(index: number): TValue | undefined {
    RingBuffer.ensureValidOffset(index, this.sizeValue);

    if (this.isEmpty) {
      return undefined;
    }

    const physicalIndex = (this.head + index) % this.capacityValue;
    return this.storage[physicalIndex];
  }

  public toArray(): TValue[] {
    const values: TValue[] = [];

    for (let index = 0; index < this.sizeValue; index += 1) {
      const value = this.at(index);

      if (value !== undefined) {
        values.push(value);
      }
    }

    return values;
  }

  public clear(): void {
    this.storage.fill(undefined);
    this.head = 0;
    this.sizeValue = 0;
  }

  public getStats(): RingBufferStats {
    return {
      capacity: this.capacity,
      size: this.size,
      isFull: this.isFull,
      oldestIndex: this.isEmpty ? null : this.head,
      newestIndex: this.isEmpty
        ? null
        : (this.head + this.sizeValue - 1) % this.capacityValue,
    };
  }

  private getWriteIndex(): number {
    if (this.isFull) {
      return this.head;
    }

    return (this.head + this.sizeValue) % this.capacityValue;
  }

  private static ensurePositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  private static ensureValidOffset(index: number, size: number): void {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('index must be a non-negative integer');
    }

    if (index >= size && size > 0) {
      throw new Error('index is out of range');
    }
  }
}
