import type { IFriendNetworkTreeNode } from '../services/friend-network-types.js';
import type { IBackendArtifacts } from './types.js';
import { readdir, readFile, stat } from 'node:fs/promises';

import path from 'node:path';

const parseJson = <T>(raw: string): T => JSON.parse(raw) as T;

interface IArtifactFileCandidate {
  readonly absolutePath: string;
  readonly mtimeMs: number;
}

const createCandidate = async (absolutePath: string): Promise<IArtifactFileCandidate | null> => {
  try {
    const detail = await stat(absolutePath);
    return {
      absolutePath,
      mtimeMs: detail.mtimeMs,
    };
  }
  catch {
    return null;
  }
};

const pickLatestByPrefix = async (directory: string, prefixes: readonly string[]): Promise<string | null> => {
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  }
  catch {
    return null;
  }
  const candidates: IArtifactFileCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) {
      continue;
    }
    if (!prefixes.some(prefix => name.startsWith(prefix))) {
      continue;
    }
    const candidate = await createCandidate(path.join(directory, name));
    if (candidate) {
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.absolutePath ?? null;
};

const resolveArtifactPath = async (
  rootDir: string,
  preferredFileName: string,
  fallbackPrefixes: readonly string[],
): Promise<string> => {
  const tmpDir = path.join(rootDir, 'tmp');
  const preferredPath = path.join(tmpDir, preferredFileName);
  const preferred = await createCandidate(preferredPath);
  if (preferred) {
    return preferred.absolutePath;
  }
  const fallback = await pickLatestByPrefix(tmpDir, fallbackPrefixes);
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `缺少 artifacts: ${preferredFileName}，且未找到 ${fallbackPrefixes.join(', ')}*.json`,
  );
};

const readArtifactJson = async <T>(absolutePath: string): Promise<T> => {
  return parseJson<T>(await readFile(absolutePath, 'utf8'));
};

type LegacyTreeNode = Readonly<{
  keyword?: unknown;
  weight?: unknown;
  status?: unknown;
  temperature?: unknown;
  weakSignal?: unknown;
  reasons?: unknown;
  children?: unknown;
}>;

type LegacyFriendNetworkSnapshot = Readonly<{
  generatedAtBeijing?: unknown;
  sourceNewsFilePath?: unknown;
  roots?: unknown;
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  return value !== null && typeof value === 'object';
};

const hasGraphSnapshot = (value: unknown): value is IBackendArtifacts['graphSnapshot'] => {
  return isRecord(value)
    && isRecord(value.graph)
    && Array.isArray(value.graph.nodes)
    && Array.isArray(value.graph.relationships);
};

const toLegacyTreeNode = (node: LegacyTreeNode): IFriendNetworkTreeNode | null => {
  if (typeof node.keyword !== 'string' || node.keyword.trim().length === 0) {
    return null;
  }
  const children = Array.isArray(node.children)
    ? node.children
        .filter(isRecord)
        .map(child => toLegacyTreeNode(child))
        .filter((child): child is IFriendNetworkTreeNode => child !== null)
    : [];
  return {
    keyword: node.keyword,
    weight: typeof node.weight === 'number' ? node.weight : 1,
    status: node.status === 'invalid' || node.status === 'unknown' ? node.status : 'effective',
    temperature: node.temperature === 'hot' || node.temperature === 'warming' ? node.temperature : 'cold',
    weakSignal: node.weakSignal === true,
    reasons: Array.isArray(node.reasons) ? node.reasons.filter((reason): reason is string => typeof reason === 'string') : [],
    childrenKeywords: children.map(child => child.keyword),
    children,
  };
};

const normalizeGraphSnapshot = (raw: unknown): IBackendArtifacts['graphSnapshot'] => {
  if (hasGraphSnapshot(raw)) {
    return raw;
  }
  const legacy = raw as LegacyFriendNetworkSnapshot;
  const roots = Array.isArray(legacy.roots)
    ? legacy.roots
        .filter(isRecord)
        .map(root => toLegacyTreeNode(root))
        .filter((root): root is IFriendNetworkTreeNode => root !== null)
    : [];
  const nodeMap = new Map<string, IFriendNetworkTreeNode>();
  const relationships: IBackendArtifacts['graphSnapshot']['graph']['relationships'][number][] = [];
  const generatedAt = typeof legacy.generatedAtBeijing === 'string'
    ? legacy.generatedAtBeijing
    : new Date().toISOString();
  const visit = (node: IFriendNetworkTreeNode): void => {
    const existing = nodeMap.get(node.keyword);
    nodeMap.set(node.keyword, {
      ...node,
      weight: Math.max(existing?.weight ?? 0, node.weight),
    });
    for (const child of node.children) {
      relationships.push({
        sourceKeyword: node.keyword,
        targetKeyword: child.keyword,
        relationType: 'transmission',
        direction: 'forward',
        confidence: Math.max(0, Math.min(1, child.weight)),
        status: child.status,
        weakSignal: child.weakSignal,
        evidence: child.reasons,
        updatedAt: generatedAt,
      });
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return {
    generatedAtBeijing: generatedAt,
    sourceNewsFilePath: typeof legacy.sourceNewsFilePath === 'string' ? legacy.sourceNewsFilePath : '',
    graph: {
      nodes: [...nodeMap.values()].map(node => ({
        keyword: node.keyword,
        category: 'theme',
        frequency: Math.max(1, Math.round(node.weight)),
        temperature: node.temperature,
        weakSignal: node.weakSignal,
      })),
      relationships,
    },
    tree: {
      depthLimit: 20,
      rootKeywords: roots.map(root => root.keyword),
      roots,
    },
    aiDecisions: [],
  };
};

export class BackendArtifactsLoader {
  public constructor(private readonly rootDir: string) {}

  public async load(): Promise<IBackendArtifacts> {
    const graphPath = await resolveArtifactPath(this.rootDir, 'friend-network-latest.json', [
      'friend-network-latest',
      'friend-network-',
    ]);
    const recommendationPath = await resolveArtifactPath(
      this.rootDir,
      'recommendations-latest.json',
      ['recommendations-latest', 'recommendations-'],
    );
    const stockPath = await resolveArtifactPath(this.rootDir, 'stock-sync-latest.json', [
      'stock-sync-latest',
      'stock-sync-',
    ]);

    const graphSnapshot = normalizeGraphSnapshot(await readArtifactJson<unknown>(graphPath));
    const recommendationFile
      = await readArtifactJson<IBackendArtifacts['recommendationFile']>(recommendationPath);
    const stockPayload
      = await readArtifactJson<IBackendArtifacts['stockPayload']>(stockPath);
    return {
      graphSnapshot,
      recommendationFile,
      stockPayload,
    };
  }
}
