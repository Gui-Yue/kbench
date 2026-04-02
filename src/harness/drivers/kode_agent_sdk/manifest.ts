import type { HarnessDescriptor } from '../../types.js';

export const kodeAgentSdkHarness: HarnessDescriptor = {
  id: 'kode-agent-sdk',
  kind: 'sdk',
  description: 'Built-in driver for Kode Agent SDK task and session benchmarks.',
  supportedBenchmarks: ['swe', 'tb2', 'tau', 'sae'],
  capabilities: {
    runModes: ['task', 'session'],
    machineReadableStdout: true,
    supportsPatchOutput: false,
    supportsTrajectory: false,
    supportsToolCallTrace: false,
    supportsResume: false,
    supportsImages: false,
    supportsSandboxBridge: false,
    supportsPromptTemplate: true,
  },
};
