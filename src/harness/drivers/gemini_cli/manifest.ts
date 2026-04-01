import type { HarnessDescriptor } from '../../types.js';

export const geminiCliHarness: HarnessDescriptor = {
  id: 'gemini-cli',
  kind: 'cli',
  description: 'Experimental task driver for Gemini CLI using --prompt and stream-json output.',
  supportedBenchmarks: ['swe', 'tb2'],
  capabilities: {
    runModes: ['task'],
    machineReadableStdout: true,
    supportsPatchOutput: true,
    supportsTrajectory: true,
    supportsToolCallTrace: true,
    supportsResume: true,
    supportsImages: false,
    supportsSandboxBridge: false,
    supportsPromptTemplate: false,
  },
};
