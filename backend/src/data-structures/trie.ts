export interface TrieStats {
  readonly keyCount: number;
  readonly nodeCount: number;
}

class TrieNode {
  private readonly childrenMap = new Map<string, TrieNode>();
  private terminal = false;

  public get isTerminal(): boolean {
    return this.terminal;
  }

  public markTerminal(): boolean {
    if (this.terminal) {
      return false;
    }

    this.terminal = true;
    return true;
  }

  public getChild(symbol: string): TrieNode | undefined {
    return this.childrenMap.get(symbol);
  }

  public getOrCreateChild(symbol: string): { readonly node: TrieNode; readonly created: boolean } {
    const existingChild = this.childrenMap.get(symbol);

    if (existingChild !== undefined) {
      return { node: existingChild, created: false };
    }

    const child = new TrieNode();
    this.childrenMap.set(symbol, child);

    return { node: child, created: true };
  }

  public get children(): ReadonlyMap<string, TrieNode> {
    return this.childrenMap;
  }
}

export class Trie {
  private readonly root = new TrieNode();
  private keyCountValue = 0;
  private nodeCountValue = 1;

  public get keyCount(): number {
    return this.keyCountValue;
  }

  public get nodeCount(): number {
    return this.nodeCountValue;
  }

  public insert(key: string): void {
    Trie.ensureNonEmptyKey(key);

    let currentNode = this.root;

    for (const symbol of key) {
      const { node, created } = currentNode.getOrCreateChild(symbol);
      currentNode = node;

      if (created) {
        this.nodeCountValue += 1;
      }
    }

    if (currentNode.markTerminal()) {
      this.keyCountValue += 1;
    }
  }

  public contains(key: string): boolean {
    Trie.ensureNonEmptyKey(key);

    const node = this.findNode(key);
    return node?.isTerminal ?? false;
  }

  public hasPrefix(prefix: string): boolean {
    Trie.ensureNonEmptyKey(prefix);

    return this.findNode(prefix) !== undefined;
  }

  public findByPrefix(prefix: string): string[] {
    Trie.ensureNonEmptyKey(prefix);

    const startNode = this.findNode(prefix);

    if (startNode === undefined) {
      return [];
    }

    const matches: string[] = [];
    this.collectKeys(startNode, prefix, matches);
    return matches;
  }

  public getStats(): TrieStats {
    return {
      keyCount: this.keyCount,
      nodeCount: this.nodeCount,
    };
  }

  private findNode(value: string): TrieNode | undefined {
    let currentNode: TrieNode | undefined = this.root;

    for (const symbol of value) {
      currentNode = currentNode?.getChild(symbol);

      if (currentNode === undefined) {
        return undefined;
      }
    }

    return currentNode;
  }

  private collectKeys(node: TrieNode, prefix: string, matches: string[]): void {
    if (node.isTerminal) {
      matches.push(prefix);
    }

    const orderedChildren = Array.from(node.children.entries()).sort(([left], [right]) => {
      return left.localeCompare(right);
    });

    for (const [symbol, child] of orderedChildren) {
      this.collectKeys(child, `${prefix}${symbol}`, matches);
    }
  }

  private static ensureNonEmptyKey(value: string): void {
    if (value.length === 0) {
      throw new Error('key must not be empty');
    }
  }
}
