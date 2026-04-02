import type { HarnessDescriptor } from '../../types.js';

export const codexHarness: HarnessDescriptor = {
  id: 'codex',
  kind: 'cli',
  description: 'Built-in task driver for Codex CLI using codex exec --json.',
  supportedBenchmarks: ['swe', 'tb2'],
  capabilities: {
    runModes: ['task'],
    machineReadableStdout: true,
    supportsPatchOutput: true,
    supportsTrajectory: false,
    supportsToolCallTrace: true,
    supportsResume: false,
    supportsImages: false,
    supportsSandboxBridge: false,
    supportsPromptTemplate: false,
  },
};
