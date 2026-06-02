const FNV_OFFSET_BASIS = 0x811C9DC5;
const FNV_PRIME = 0x01000193;
const UINT32_MASK = 0xFFFFFFFF;
const LN_2 = Math.log(2);

export interface BloomFilterOptions {
  readonly size: number;
  readonly hashCount: number;
}

export interface BloomFilterStats {
  readonly size: number;
  readonly hashCount: number;
  readonly insertedCount: number;
  readonly setBitCount: number;
  readonly fillRatio: number;
  readonly estimatedFalsePositiveRate: number;
}

export interface BloomFilterCapacityPlan {
  readonly size: number;
  readonly hashCount: number;
  readonly expectedInsertions: number;
  readonly targetFalsePositiveRate: number;
}

export class BloomFilter {
  private readonly bits: Uint8Array;
  private insertedCountValue = 0;
  private setBitCountValue = 0;

  public constructor(private readonly options: BloomFilterOptions) {
    BloomFilter.ensurePositiveInteger(options.size, 'size');
    BloomFilter.ensurePositiveInteger(options.hashCount, 'hashCount');

    this.bits = new Uint8Array(options.size);
  }

  public static createForCapacity(
    expectedInsertions: number,
    targetFalsePositiveRate: number,
  ): BloomFilter {
    return new BloomFilter(
      BloomFilter.planCapacity(expectedInsertions, targetFalsePositiveRate),
    );
  }

  public static planCapacity(
    expectedInsertions: number,
    targetFalsePositiveRate: number,
  ): BloomFilterCapacityPlan {
    BloomFilter.ensurePositiveInteger(expectedInsertions, 'expectedInsertions');

    if (!(targetFalsePositiveRate > 0 && targetFalsePositiveRate < 1)) {
      throw new Error('targetFalsePositiveRate must be between 0 and 1');
    }

    const size = Math.max(
      1,
      Math.ceil(
        (-expectedInsertions * Math.log(targetFalsePositiveRate)) / (LN_2 * LN_2),
      ),
    );
    const hashCount = Math.max(1, Math.round((size / expectedInsertions) * LN_2));

    return {
      size,
      hashCount,
      expectedInsertions,
      targetFalsePositiveRate,
    };
  }

  public get size(): number {
    return this.options.size;
  }

  public get hashCount(): number {
    return this.options.hashCount;
  }

  public get insertedCount(): number {
    return this.insertedCountValue;
  }

  public add(value: string): void {
    const indexes = this.computeIndexes(value);

    for (const index of indexes) {
      if (this.bits[index] === 0) {
        this.bits[index] = 1;
        this.setBitCountValue += 1;
      }
    }

    this.insertedCountValue += 1;
  }

  public mightContain(value: string): boolean {
    const indexes = this.computeIndexes(value);

    for (const index of indexes) {
      if (this.bits[index] === 0) {
        return false;
      }
    }

    return true;
  }

  public getStats(): BloomFilterStats {
    const fillRatio = this.setBitCountValue / this.size;

    return {
      size: this.size,
      hashCount: this.hashCount,
      insertedCount: this.insertedCountValue,
      setBitCount: this.setBitCountValue,
      fillRatio,
      estimatedFalsePositiveRate: this.estimateFalsePositiveRate(this.insertedCountValue),
    };
  }

  public estimateFalsePositiveRate(insertedCount: number = this.insertedCountValue): number {
    if (insertedCount <= 0) {
      return 0;
    }

    return (1 - Math.exp((-this.hashCount * insertedCount) / this.size)) ** this.hashCount;
  }

  private computeIndexes(value: string): number[] {
    const firstHash = BloomFilter.hash(value, 0);
    const secondHash = BloomFilter.hash(value, 1) || 1;
    const indexes: number[] = [];

    for (let iteration = 0; iteration < this.hashCount; iteration += 1) {
      const mixed = (firstHash + iteration * secondHash + iteration * iteration) >>> 0;
      indexes.push(mixed % this.size);
    }

    return indexes;
  }

  private static hash(value: string, seed: number): number {
    let hash = (FNV_OFFSET_BASIS ^ seed) >>> 0;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash &= UINT32_MASK;
    }

    return hash >>> 0;
  }

  private static ensurePositiveInteger(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}
