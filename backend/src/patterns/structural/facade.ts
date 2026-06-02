export interface IFetchSubsystem {
  fetch: (query: string) => readonly string[];
}

export interface IDedupSubsystem {
  removeDuplicates: (items: readonly string[]) => readonly string[];
}

export interface IStoreSubsystem {
  save: (items: readonly string[]) => number;
}

export interface IIngestResult {
  readonly fetchedCount: number;
  readonly storedCount: number;
  readonly items: readonly string[];
}

export class NewsIngestFacade {
  public constructor(
    private readonly fetchSubsystem: IFetchSubsystem,
    private readonly dedupSubsystem: IDedupSubsystem,
    private readonly storeSubsystem: IStoreSubsystem,
  ) {}

  public ingest(query: string): IIngestResult {
    const fetchedItems = this.fetchSubsystem.fetch(query);
    const uniqueItems = this.dedupSubsystem.removeDuplicates(fetchedItems);
    const storedCount = this.storeSubsystem.save(uniqueItems);

    return {
      fetchedCount: fetchedItems.length,
      storedCount,
      items: uniqueItems,
    } satisfies IIngestResult;
  }
}
