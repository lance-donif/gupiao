import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const parseJson = <T>(raw: string): T => JSON.parse(raw) as T;

export class JsonFileStore<T> {
  public constructor(
    private readonly filePath: string,
    private readonly defaultFactory: () => T,
  ) {}

  public async read(): Promise<T> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return parseJson<T>(raw);
    }
    catch {
      const fallback = this.defaultFactory();
      await this.write(fallback);
      return fallback;
    }
  }

  public async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  public async update(updater: (current: T) => T | Promise<T>): Promise<T> {
    const current = await this.read();
    const next = await updater(current);
    await this.write(next);
    return next;
  }
}
