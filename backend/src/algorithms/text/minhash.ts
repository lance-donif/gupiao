const UINT32_MASK = 0xFFFFFFFF;
const DEFAULT_SIGNATURE_SIZE = 256;
const PRIME_MODULUS = 4_294_967_291;
const BASE_A = 1_000_003;
const BASE_B = 97_409;

export interface MinHashOptions {
  readonly signatureSize?: number;
}

export interface MinHashSignature {
  readonly values: readonly number[];
}

export class MinHash {
  private readonly signatureSizeValue: number;

  public constructor(options: MinHashOptions = {}) {
    this.signatureSizeValue = options.signatureSize ?? DEFAULT_SIGNATURE_SIZE;

    if (!Number.isInteger(this.signatureSizeValue) || this.signatureSizeValue <= 0) {
      throw new Error('signatureSize must be a positive integer');
    }
  }

  public createSignature(tokens: readonly string[]): MinHashSignature {
    const uniqueTokens = Array.from(new Set(tokens));

    if (uniqueTokens.length === 0) {
      return {
        values: new Array<number>(this.signatureSizeValue).fill(PRIME_MODULUS),
      };
    }

    const values = new Array<number>(this.signatureSizeValue).fill(PRIME_MODULUS);

    for (const token of uniqueTokens) {
      const tokenHash = this.hashToken(token);

      for (let index = 0; index < this.signatureSizeValue; index += 1) {
        const candidate = this.computePermutationHash(tokenHash, index);

        if (candidate < values[index]) {
          values[index] = candidate;
        }
      }
    }

    return { values };
  }

  public estimateSimilarity(leftTokens: readonly string[], rightTokens: readonly string[]): number {
    const leftSignature = this.createSignature(leftTokens);
    const rightSignature = this.createSignature(rightTokens);

    return this.compareSignatures(leftSignature, rightSignature);
  }

  public compareSignatures(left: MinHashSignature, right: MinHashSignature): number {
    if (left.values.length !== right.values.length) {
      throw new Error('signature lengths must match');
    }

    let matches = 0;

    for (let index = 0; index < left.values.length; index += 1) {
      if (left.values[index] === right.values[index]) {
        matches += 1;
      }
    }

    return matches / left.values.length;
  }

  private computePermutationHash(tokenHash: number, index: number): number {
    const a = (BASE_A + index * 2_147_483) % PRIME_MODULUS;
    const b = (BASE_B + index * 65_537) % PRIME_MODULUS;

    return (a * tokenHash + b) % PRIME_MODULUS;
  }

  private hashToken(token: string): number {
    let hash = 2_166_136_261;

    for (const symbol of token) {
      hash ^= symbol.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16_777_619) >>> 0;
      hash &= UINT32_MASK;
    }

    return hash % PRIME_MODULUS;
  }
}
