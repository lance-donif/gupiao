export type KeywordCategory = 'company' | 'industry' | 'theme' | 'macro' | 'other';

export class Keyword {
  public readonly relations: string[];

  public constructor(
    public readonly id: string,
    public readonly word: string,
    public readonly category: KeywordCategory,
    relations: readonly string[] = [],
  ) {
    this.relations = [...relations];
  }

  public equals(other: Keyword): boolean {
    return this.id === other.id;
  }
}
