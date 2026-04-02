import type { HarnessDescriptor } from '../../types.js';

export const claudeCodeHarness: HarnessDescriptor = {
  id: 'claude-code',
  kind: 'cli',
  description: 'Built-in task driver for Claude Code using stream-json output.',
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
