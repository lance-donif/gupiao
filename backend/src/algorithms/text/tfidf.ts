export interface TfidfVector {
  readonly termWeights: Readonly<Record<string, number>>;
  readonly weights: readonly number[];
}

export interface TfidfResult {
  readonly vocabulary: readonly string[];
  readonly vectors: readonly TfidfVector[];
}

export class TfidfVectorizer {
  public fitTransform(documents: readonly (readonly string[])[]): TfidfResult {
    if (documents.length === 0) {
      return {
        vocabulary: [],
        vectors: [],
      };
    }

    const vocabulary = this.buildVocabulary(documents);
    const inverseDocumentFrequency = this.computeInverseDocumentFrequency(documents, vocabulary);
    const vectors = documents.map((document) => {
      return this.createNormalizedVector(document, vocabulary, inverseDocumentFrequency);
    });

    return {
      vocabulary,
      vectors,
    };
  }

  private buildVocabulary(documents: readonly (readonly string[])[]): string[] {
    const vocabularySet = new Set<string>();

    for (const document of documents) {
      for (const token of document) {
        vocabularySet.add(token);
      }
    }

    return Array.from(vocabularySet).sort((left, right) => left.localeCompare(right));
  }

  private computeInverseDocumentFrequency(
    documents: readonly (readonly string[])[],
    vocabulary: readonly string[],
  ): Map<string, number> {
    const documentCount = documents.length;
    const frequencies = new Map<string, number>();

    for (const token of vocabulary) {
      frequencies.set(token, 0);
    }

    for (const document of documents) {
      const uniqueTokens = new Set(document);

      for (const token of uniqueTokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
    }

    const inverseDocumentFrequency = new Map<string, number>();

    for (const token of vocabulary) {
      const documentFrequency = frequencies.get(token) ?? 0;
      inverseDocumentFrequency.set(token, Math.log((1 + documentCount) / (1 + documentFrequency)) + 1);
    }

    return inverseDocumentFrequency;
  }

  private createNormalizedVector(
    document: readonly string[],
    vocabulary: readonly string[],
    inverseDocumentFrequency: ReadonlyMap<string, number>,
  ): TfidfVector {
    const termFrequency = this.computeTermFrequency(document);
    const rawWeights = vocabulary.map((token) => {
      return (termFrequency.get(token) ?? 0) * (inverseDocumentFrequency.get(token) ?? 0);
    });
    const magnitude = Math.sqrt(rawWeights.reduce((sum, value) => sum + value * value, 0));
    const normalizedWeights = magnitude === 0 ? rawWeights : rawWeights.map(value => value / magnitude);
    const termWeights: Record<string, number> = {};

    for (let index = 0; index < vocabulary.length; index += 1) {
      termWeights[vocabulary[index]] = normalizedWeights[index];
    }

    return {
      termWeights,
      weights: normalizedWeights,
    };
  }

  private computeTermFrequency(document: readonly string[]): Map<string, number> {
    const frequencyMap = new Map<string, number>();

    if (document.length === 0) {
      return frequencyMap;
    }

    for (const token of document) {
      frequencyMap.set(token, (frequencyMap.get(token) ?? 0) + 1);
    }

    for (const [token, count] of frequencyMap.entries()) {
      frequencyMap.set(token, count / document.length);
    }

    return frequencyMap;
  }
}
