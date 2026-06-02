import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface IRawNewsRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly capturedAt: string;
}

export interface IRawNewsFilePayload {
  readonly rawNews?: readonly IRawNewsRecord[];
}

export interface IFriendTreeNode {
  readonly keyword: string;
  readonly weight: number;
  readonly status: 'effective';
  readonly temperature: 'hot' | 'cold';
  readonly weakSignal: boolean;
  readonly reasons: readonly string[];
  readonly children: readonly IFriendTreeNode[];
}

export interface IFriendRelationshipTreeReport {
  readonly generatedAtBeijing: string;
  readonly sourceNewsFilePath: string;
  readonly newsCount: number;
  readonly keywordCount: number;
  readonly relationshipCount: number;
  readonly roots: readonly IFriendTreeNode[];
}

interface IKeywordStats {
  count: number;
  reasons: Set<string>;
}

interface IBuildFriendRelationshipTreeInput {
  readonly payload: IRawNewsFilePayload;
  readonly sourceNewsFilePath: string;
  readonly generatedAtBeijing: string;
}

const STOP_WORDS = new Set([
  '今日', '今天', '今年', '公司', '行业', '市场', '相关', '提升', '带动', '推动', '关注', '加快',
  '建设', '实现', '预计', '项目', '扩大', '新闻', '日电', '表示', '一个', '进行', '以及',
  '需求', '材料', '话题', '改善', '回暖', '升温', '共同', '作为', '这个', '那个', '我们',
]);

const toBeijingTime = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
};

export const extractNewsRecordsFromPayload = (payload: IRawNewsFilePayload): readonly IRawNewsRecord[] => {
  return payload.rawNews ?? [];
};

const tokenize = (text: string): string[] => {
  const chineseMatches = text.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
  return chineseMatches.filter((token) => !STOP_WORDS.has(token));
};

const collectKeywords = (news: readonly IRawNewsRecord[]): Map<string, IKeywordStats> => {
  const keywordStats = new Map<string, IKeywordStats>();

  for (const item of news) {
    const tokens = new Set(tokenize(`${item.title} ${item.summary}`));
    for (const token of tokens) {
      const current = keywordStats.get(token) ?? { count: 0, reasons: new Set<string>() };
      current.count += 1;
      current.reasons.add(item.title);
      keywordStats.set(token, current);
    }
  }

  return keywordStats;
};

const buildRelationships = (news: readonly IRawNewsRecord[]): Map<string, number> => {
  const relationshipWeights = new Map<string, number>();

  for (const item of news) {
    const tokens = [...new Set(tokenize(`${item.title} ${item.summary}`))];
    for (let leftIndex = 0; leftIndex < tokens.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < tokens.length; rightIndex += 1) {
        const left = tokens[leftIndex];
        const right = tokens[rightIndex];
        if (!left || !right) {
          continue;
        }

        const [from, to] = [left, right].sort((a, b) => a.localeCompare(b));
        const key = `${from}::${to}`;
        relationshipWeights.set(key, (relationshipWeights.get(key) ?? 0) + 1);
      }
    }
  }

  return relationshipWeights;
};

const createTemperature = (count: number): 'hot' | 'cold' => {
  return count >= 2 ? 'hot' : 'cold';
};

const createWeakSignal = (count: number, connectedHotKeyword: boolean): boolean => {
  return count === 1 && connectedHotKeyword;
};

export const buildFriendRelationshipTree = (
  input: IBuildFriendRelationshipTreeInput,
): IFriendRelationshipTreeReport => {
  const news = extractNewsRecordsFromPayload(input.payload);
  const keywordStats = collectKeywords(news);
  const relationshipWeights = buildRelationships(news);
  const sortedKeywords = [...keywordStats.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]));

  const topKeywords = sortedKeywords.map(([keyword]) => keyword);
  const hotKeywords = new Set(sortedKeywords.filter(([, stats]) => stats.count >= 2).map(([keyword]) => keyword));
  const adjacency = new Map<string, Array<{ keyword: string; weight: number }>>();

  for (const [pair, weight] of relationshipWeights.entries()) {
    const [left, right] = pair.split('::');
    if (!left || !right) {
      continue;
    }

    adjacency.set(left, [...(adjacency.get(left) ?? []), { keyword: right, weight }]);
    adjacency.set(right, [...(adjacency.get(right) ?? []), { keyword: left, weight }]);
  }

  const buildNode = (keyword: string, visited: Set<string>, depth: number): IFriendTreeNode => {
    const stats = keywordStats.get(keyword) ?? { count: 0, reasons: new Set<string>() };
    const neighbors = (adjacency.get(keyword) ?? [])
      .filter((neighbor) => !visited.has(neighbor.keyword))
      .sort((left, right) => right.weight - left.weight || left.keyword.localeCompare(right.keyword))
      .slice(0, depth === 0 ? 4 : 3);

    const nextVisited = new Set(visited);
    nextVisited.add(keyword);

    const children = depth >= 2
      ? []
      : neighbors.map((neighbor) => buildNode(neighbor.keyword, nextVisited, depth + 1));

    return {
      keyword,
      weight: stats.count,
      status: 'effective',
      temperature: createTemperature(stats.count),
      weakSignal: createWeakSignal(stats.count, neighbors.some((neighbor) => hotKeywords.has(neighbor.keyword))),
      reasons: [...stats.reasons].slice(0, 3),
      children,
    };
  };

  return {
    generatedAtBeijing: input.generatedAtBeijing,
    sourceNewsFilePath: input.sourceNewsFilePath,
    newsCount: news.length,
    keywordCount: keywordStats.size,
    relationshipCount: relationshipWeights.size,
    roots: topKeywords.map((keyword) => buildNode(keyword, new Set<string>(), 0)),
  };
};

const resolveTmpDirectory = (): string => {
  return path.resolve(process.cwd(), 'tmp');
};

const resolveNewsFilePath = async (): Promise<string> => {
  const candidateDirectories = [
    path.resolve(process.cwd(), 'backend', 'tmp'),
    resolveTmpDirectory(),
  ];

  for (const directory of candidateDirectories) {
    try {
      const files = (await readdir(directory))
        .filter((file) => file.includes('raw-news') && file.endsWith('.json'))
        .sort()
        .reverse();
      if (files.length > 0) {
        return path.join(directory, files[0] as string);
      }
    } catch {
      continue;
    }
  }

  throw new Error('未找到新闻临时文件');
};

async function saveFriendNetworkReport(report: IFriendRelationshipTreeReport): Promise<string> {
  const tmpDirectory = resolveTmpDirectory();
  await mkdir(tmpDirectory, { recursive: true });
  const fileName = `friend-network-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const filePath = path.join(tmpDirectory, fileName);
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

async function main(): Promise<void> {
  const sourceNewsFilePath = process.argv[2] ? path.resolve(process.argv[2]) : await resolveNewsFilePath();
  const payload = JSON.parse(await readFile(sourceNewsFilePath, 'utf8')) as IRawNewsFilePayload;
  const report = buildFriendRelationshipTree({
    payload,
    sourceNewsFilePath,
    generatedAtBeijing: toBeijingTime(new Date().toISOString()),
  });
  const outputPath = await saveFriendNetworkReport(report);

  console.log(`新闻数: ${report.newsCount}`);
  console.log(`关键词数: ${report.keywordCount}`);
  console.log(`关系数: ${report.relationshipCount}`);
  console.log(`已输出到: ${outputPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
