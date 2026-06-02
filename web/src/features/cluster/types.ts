export type ClusterStatus = '正常' | '需升级' | '升级中...' | '未知';

export interface Cluster {
  id: string;
  name: string;
  winRate: string;
  status: ClusterStatus;
  disabled?: boolean;
}

export interface ClusterVersion {
  id: string;
  cluster_id: string;
  version: number;
  created_at: string;
  winrate: number | null;
  max_drawdown: number | null;
  leadtime_median: number | null;
  notes: string | null;
}

export interface ClusterFeedback {
  cluster_id: string;
  as_of_trade_date: string;
  ticker: string;
  score: 1 | -1;
  reason: string | null;
}

export interface ClusterRollbackRequest {
  cluster_id: string;
  target_version_id: string;
  reason: string;
}

export interface ClusterPromoteRequest {
  cluster_id: string;
  reason: string;
}
