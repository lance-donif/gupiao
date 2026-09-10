import { randomUUID } from 'node:crypto';

/**
 * 内存版 Prisma 客户端：覆盖管线阶段执行所需的集合、事务与原始 SQL。
 * 事务采用快照/回滚语义，便于验证"阶段失败不留产物"。
 */
type Row = Record<string, any>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? `${v}` : v)) as T;

class Collection {
  public constructor(public rows: Row[] = []) {}
  private match(row: Row, where?: Row): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
        if ('in' in cond) return (cond.in as unknown[]).includes(value);
        if ('equals' in cond) return value === cond.equals;
        if ('not' in cond) return value !== cond.not;
        if ('gt' in cond) return value > cond.gt;
        if ('gte' in cond) return value >= cond.gte;
        if ('lt' in cond) return value < cond.lt;
        if ('lte' in cond) return value <= cond.lte;
        return JSON.stringify(value) === JSON.stringify(cond);
      }
      return value === cond;
    });
  }
  public async findMany(args?: { where?: Row }): Promise<Row[]> { return clone(this.rows.filter(row => this.match(row, args?.where))); }
  public async findFirst(args?: { where?: Row }): Promise<Row | null> { return this.findMany(args).then(rows => rows[0] ?? null); }
  public async findUnique(args?: { where?: Row }): Promise<Row | null> { return this.findFirst(args); }
  public async count(args?: { where?: Row }): Promise<number> { return this.findMany(args).then(rows => rows.length); }
  public async create(args: { data: Row }): Promise<Row> {
    const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...clone(args.data) };
    this.rows.push(row);
    return clone(row);
  }
  public async createMany(args: { data: Row[] }): Promise<{ count: number }> {
    for (const data of args.data) await this.create({ data });
    return { count: args.data.length };
  }
  public async update(args: { where: Row; data: Row }): Promise<Row> {
    const row = this.rows.find(item => this.match(item, args.where));
    if (!row) throw new Error('update target not found');
    Object.assign(row, clone(args.data), { updatedAt: new Date() });
    return clone(row);
  }
  public async updateMany(args: { where: Row; data: Row }): Promise<{ count: number }> {
    const rows = this.rows.filter(item => this.match(item, args.where));
    for (const row of rows) Object.assign(row, clone(args.data));
    return { count: rows.length };
  }
  public async upsert(args: { where: Row; create: Row; update: Row }): Promise<Row> {
    const existing = this.rows.find(item => this.match(item, args.where));
    if (existing) { Object.assign(existing, clone(args.update)); return clone(existing); }
    return this.create({ data: { ...args.where, ...args.create } });
  }
  public async deleteMany(args?: { where?: Row }): Promise<{ count: number }> {
    const before = this.rows.length;
    this.rows = args?.where ? this.rows.filter(row => !this.match(row, args.where)) : [];
    return { count: before - this.rows.length };
  }
}

export class MemoryPrisma {
  /** 代理会把任意属性名解析成对应集合，因此这里允许动态集合访问。 */
  [key: string]: any;
  private readonly collections = new Map<string, Collection>();
  public readonly rawCalls: Array<{ query: string; args: unknown[] }> = [];
  public transactionFailures = 0;

  public collection(name: string): Collection {
    let collection = this.collections.get(name);
    if (!collection) { collection = new Collection(); this.collections.set(name, collection); }
    return collection;
  }

  public get(_target: string, property: string | symbol): unknown {
    if (typeof property !== 'string') return undefined;
    if (property.startsWith('$')) return (this as Record<string, unknown>)[property];
    return this.collection(property);
  }

  private proxy!: MemoryPrisma;

  public constructor() {
    const proxy = new Proxy(this, {
      get(target, property, receiver) {
        if (typeof property === 'string' && property in target && !(property in target.collections)) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value === 'function') return value.bind(target);
          return value;
        }
        if (typeof property === 'string') return target.collection(property);
        return Reflect.get(target, property, receiver);
      },
    }) as MemoryPrisma;
    this.proxy = proxy;
    return proxy;
  }

  public async $transaction<T>(work: (tx: MemoryPrisma) => Promise<T>): Promise<T> {
    const snapshot = new Map([...this.collections].map(([name, collection]) => [name, clone(collection.rows)]));
    try {
      return await work(this.proxy);
    } catch (error) {
      this.transactionFailures += 1;
      for (const [name, rows] of snapshot) this.collection(name).rows = rows;
      throw error;
    }
  }

  public async $queryRawUnsafe(query: string, ...args: unknown[]): Promise<unknown[]> {
    this.rawCalls.push({ query, args });
    if (query.includes('"PipelineCheckpoint"')) {
      return this.collection('pipelineCheckpoint').rows
        .filter(row => row.traceId === args[0] && row.stage === args[1])
        .map(row => ({ input: row.input, result: row.result }));
    }
    if (query.includes('"DataRefreshLedger"')) {
      const [dataKind, source, clusterKey, bucketKeys, status, asOf] = args;
      const allowed = new Set(bucketKeys as unknown[]);
      return this.collection('dataRefreshLedger').rows.filter(row => row.dataKind === dataKind
        && row.source === source && row.clusterKey === clusterKey && allowed.has(row.bucketKey)
        && row.status === status && new Date(row.expiresAt) > new Date(asOf as string)
        && new Date(row.fetchedAt) <= new Date(asOf as string));
    }
    return [];
  }

  public async $executeRawUnsafe(query: string, ...args: unknown[]): Promise<number> {
    this.rawCalls.push({ query, args });
    if (query.includes('INSERT INTO "PipelineCheckpoint"')) {
      const [traceId, stage, input, result] = args;
      await this.collection('pipelineCheckpoint').create({ data: { traceId, stage, input, result: JSON.parse(String(result)) } });
      return 1;
    }
    if (query.includes('INSERT INTO "DataRefreshLedger"')) {
      const [, dataKind, source, clusterKey, bucketKey, status, fetchedAt, expiresAt, traceId, summary] = args;
      const index = this.collection('dataRefreshLedger').rows.findIndex(row => row.dataKind === dataKind && row.source === source
        && row.clusterKey === clusterKey && row.bucketKey === bucketKey);
      const row = { dataKind, source, clusterKey, bucketKey, status, fetchedAt, expiresAt, traceId, summary: JSON.parse(String(summary)) };
      if (index === -1) this.collection('dataRefreshLedger').rows.push(row);
      else this.collection('dataRefreshLedger').rows[index] = row;
      return 1;
    }
    return 1;
  }

  public async $disconnect(): Promise<void> { /* no-op */ }
}

export interface INewsFixture {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly publishedAt: Date;
}

/** 固定新闻快照：内容由索引确定，保证批次规划与缓存测试可复现。 */
export function newsFixture(count: number, options: { prefix?: string; lengthFactor?: number; publishedAt?: Date } = {}): INewsFixture[] {
  const { prefix = 'news', lengthFactor = 1, publishedAt = new Date('2026-05-24T08:00:00.000Z') } = options;
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index + 1}`,
    title: `白银库存下降 ${index + 1}`,
    content: '白银库存下降，供给不足。'.repeat(Math.max(1, Math.round(20 * lengthFactor * (1 + (index % 5) / 5)))),
    source: 'aktools',
    publishedAt: new Date(publishedAt.getTime() + index * 60_000),
  }));
}

export interface ICandleFixture {
  readonly symbol: string;
  readonly tradingDay: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** 固定行情快照：价格由交易序号确定，避免随机数据导致的不可复现断言。 */
export function candleFixture(symbol: string, days: number, startDay = '2026-05-04'): ICandleFixture[] {
  return Array.from({ length: days }, (_unused, index) => {
    const tradingDay = new Date(`${startDay}T00:00:00.000Z`);
    tradingDay.setUTCDate(tradingDay.getUTCDate() + (index + Math.floor(index / 5) * 2));
    const base = 10 + (index % 7) * 0.5;
    return { symbol, tradingDay, open: base, high: base * 1.03, low: base * 0.97, close: base * 1.01, volume: 1_000_000 + index * 1000 };
  });
}
