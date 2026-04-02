import type { HarnessDescriptor } from '../../types.js';

export const customAdapterHarness: HarnessDescriptor = {
  id: 'custom-adapter',
  kind: 'workflow',
  description: 'User-provided adapter manifest and runner executed through the kbench adapter protocol.',
  supportedBenchmarks: ['swe', 'tb2', 'tau', 'sae'],
  capabilities: {
    runModes: ['task', 'session'],
    machineReadableStdout: true,
    supportsPatchOutput: true,
    supportsTrajectory: true,
    supportsToolCallTrace: true,
    supportsResume: false,
    supportsImages: false,
    supportsSandboxBridge: false,
    supportsPromptTemplate: false,
  },
};
