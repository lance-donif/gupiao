import type { Timestamp } from '../value-objects/timestamp.js';

import type { Keyword } from './keyword.js';

export class NewsItem {
  private readonly keywordsSet: Set<string>;
  private readonly mutableKeywords: Keyword[];

  public constructor(
    public readonly id: string,
    public readonly title: string,
    public readonly content: string,
    public readonly source: string,
    public readonly publishedAt: Timestamp,
    keywords: readonly Keyword[] = [],
  ) {
    this.mutableKeywords = [];
    this.keywordsSet = new Set<string>();

    for (const keyword of keywords) {
      this.addKeyword(keyword);
    }
  }

  public get keywords(): readonly Keyword[] {
    return this.mutableKeywords;
  }

  public addKeyword(keyword: Keyword): void {
    if (this.keywordsSet.has(keyword.id)) {
      return;
    }

    this.mutableKeywords.push(keyword);
    this.keywordsSet.add(keyword.id);
  }

  public equals(other: NewsItem): boolean {
    return this.id === other.id;
  }
}
