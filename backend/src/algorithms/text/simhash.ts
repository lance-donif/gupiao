const FNV_OFFSET_BASIS_64 = 0xCBF29CE484222325n;
const FNV_PRIME_64 = 0x100000001B3n;
const UINT64_MASK = 0xFFFFFFFFFFFFFFFFn;

export interface SimHashOptions {
  readonly bitLength?: number;
}

export interface SimHashFingerprint {
  readonly value: bigint;
  readonly binary: string;
  readonly bitLength: number;
}

export class SimHash {
  private readonly bitLengthValue: number;

  public constructor(options: SimHashOptions = {}) {
    this.bitLengthValue = options.bitLength ?? 64;

    if (this.bitLengthValue !== 64) {
      throw new Error('bitLength must be 64');
    }
  }

  public computeFingerprint(text: string): SimHashFingerprint {
    const tokens = this.tokenize(text);

    if (tokens.length === 0) {
      return this.createFingerprint(0n);
    }

    const weights = new Array<number>(this.bitLengthValue).fill(0);
    const frequencies = this.buildFrequencyMap(tokens);

    for (const [token, frequency] of frequencies.entries()) {
      const hash = this.hashToken(token);

      for (let bit = 0; bit < this.bitLengthValue; bit += 1) {
        const mask = 1n << BigInt(bit);
        weights[bit] += (hash & mask) === 0n ? -frequency : frequency;
      }
    }

    let value = 0n;

    for (let bit = 0; bit < this.bitLengthValue; bit += 1) {
      if (weights[bit] > 0) {
        value |= 1n << BigInt(bit);
      }
    }

    return this.createFingerprint(value);
  }

  public computeDistance(
    left: SimHashFingerprint,
    right: SimHashFingerprint,
  ): number {
    let xorValue = (left.value ^ right.value) & UINT64_MASK;
    let distance = 0;

    while (xorValue > 0n) {
      xorValue &= xorValue - 1n;
      distance += 1;
    }

    return distance;
  }

  private tokenize(text: string): string[] {
    return Array.from(text.replace(/\s+/gu, ''));
  }

  private buildFrequencyMap(tokens: readonly string[]): Map<string, number> {
    const frequencies = new Map<string, number>();

    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }

    return frequencies;
  }

  private hashToken(token: string): bigint {
    let hash = FNV_OFFSET_BASIS_64;

    for (const symbol of token) {
      hash ^= BigInt(symbol.codePointAt(0) ?? 0);
      hash = (hash * FNV_PRIME_64) & UINT64_MASK;
    }

    return hash;
  }

  private createFingerprint(value: bigint): SimHashFingerprint {
    const normalized = value & UINT64_MASK;

    return {
      value: normalized,
      bitLength: this.bitLengthValue,
      binary: normalized.toString(2).padStart(this.bitLengthValue, '0'),
    };
  }
}
