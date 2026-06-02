export const bootstrapBackend = (): string => {
  return 'backend-bootstrap-ready';
};

export { ControlledAgentStateContext } from './agent/agent-state.js';
export * from './agent/index.js';
export * from './algorithms/index.js';
export * from './data-structures/index.js';

export * from './http/index.js';
export * from './patterns/behavioral/index.js';
export * from './patterns/creational/index.js';
export * from './patterns/structural/index.js';
export * from './repositories/index.js';
export * from './scheduler/index.js';
export * from './services/index.js';
export { createServiceCli, ServiceCli } from './services/service-cli.js';
export { createServiceCompositionRoot } from './services/service-di.js';
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
  ],
};
