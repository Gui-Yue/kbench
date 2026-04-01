import type { SessionSpec, TaskEnvelope } from '../../core/protocol.js';
import type { AdapterRunnerInput } from './protocol.js';

export const taskFixture: TaskEnvelope = {
  benchmark: 'swe',
  instanceId: 'fixture-task-001',
  title: 'Sample SWE task fixture',
  instruction: 'Inspect the repository, make the minimal fix, and summarize the change.',
  metadata: {
    source: 'kbench-fixture',
  },
  env: {
    workdir: '/workspace/repo',
    repoPath: '/workspace/repo',
    sandbox: {
      type: 'host',
    },
  },
};

export const sessionFixture: SessionSpec = {
  benchmark: 'tau',
  instanceId: 'fixture-session-001',
  metadata: {
    source: 'kbench-fixture',
  },
  env: {
    workdir: '/workspace/session',
    sandbox: {
      type: 'benchmark-native',
    },
  },
  initialObservation: {
    role: 'user',
    content: 'Customer asks you to update an order and confirm the result.',
  },
  actionSpace: {
    type: 'tools+respond',
  },
};

export const taskRunnerFixture: AdapterRunnerInput = {
  mode: 'task',
  task: taskFixture,
  env: taskFixture.env,
  config: {
    modelName: 'openai/gpt-4.1-mini',
    timeoutMs: 600000,
    workDir: '/workspace/repo',
  },
};

export const sessionRunnerFixture: AdapterRunnerInput = {
  mode: 'session',
  session: sessionFixture,
  env: sessionFixture.env,
  config: {
    modelName: 'openai/gpt-4.1-mini',
    timeoutMs: 300000,
    workDir: '/workspace/session',
  },
};
