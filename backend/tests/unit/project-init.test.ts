import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { bootstrapBackend, projectStructure } from '../../src/index.js';

describe('project initialization', () => {
  it('exposes the bootstrap marker', () => {
    expect(bootstrapBackend()).toBe('backend-bootstrap-ready');
  });

  it('declares the required source directories', () => {
    expect(projectStructure.sourceDirectories).toEqual([
      'types',
      'patterns',
      'algorithms',
      'data-structures',
      'sources',
      'repositories',
      'services',
      'agent',
      'scheduler',
      'utils',
      'config',
    ]);
  });

  it('creates all declared directories on disk', () => {
    const sourceRoot = join(process.cwd(), 'src');

    for (const directory of projectStructure.sourceDirectories) {
      expect(existsSync(join(sourceRoot, directory))).toBe(true);
    }
  });
});
