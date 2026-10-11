export type NewsIngestStage = 'fetch' | 'normalize' | 'deduplicate' | 'persist';

export enum NewsIngestFailureCategory {
  SourceFailed = 'source_failed',
  PersistenceFailed = 'persistence_failed',
}

