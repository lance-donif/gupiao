export const bootstrapBackend = (): string => {
  return 'backend-bootstrap-ready';
};

export * from './http/index.js';
export * from './repositories/index.js';
export * from './services/index.js';
export * from './sources/index.js';
export * from './types/aggregates/index.js';
export * from './types/entities/index.js';
export * from './types/value-objects/index.js';

export interface IProjectStructure {
  readonly root: string;
  readonly sourceDirectories: readonly string[];
}

export const projectStructure: IProjectStructure = {
  root: 'src',
  sourceDirectories: [
    'types',
    'sources',
    'repositories',
    'services',
    'utils',
    'config',
  ],
};