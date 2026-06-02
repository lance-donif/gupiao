import { describe, expect, it } from 'vitest';

import { Keyword } from '../../../../src/index.js';

describe('Keyword', () => {
  it('stores word, category, and relations', () => {
    const keyword = new Keyword('kw-1', '机器人', 'theme', ['自动化', '制造业']);

    expect(keyword.word).toBe('机器人');
    expect(keyword.category).toBe('theme');
    expect(keyword.relations).toEqual(['自动化', '制造业']);
  });

  it('compares equality by id only', () => {
    expect(new Keyword('kw-1', '机器人', 'theme').equals(new Keyword('kw-1', '自动化', 'industry'))).toBe(
      true,
    );
    expect(new Keyword('kw-1', '机器人', 'theme').equals(new Keyword('kw-2', '机器人', 'theme'))).toBe(
      false,
    );
  });
});
