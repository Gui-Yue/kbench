import type { BenchmarkId } from '../core/protocol.js';
import { claudeCodeHarness } from './drivers/claude_code/manifest.js';
import { codexHarness } from './drivers/codex/manifest.js';
import { customAdapterHarness } from './drivers/custom_adapter/manifest.js';
import { geminiCliHarness } from './drivers/gemini_cli/manifest.js';
import { kodeAgentSdkHarness } from './drivers/kode_agent_sdk/manifest.js';
import type { HarnessDescriptor } from './types.js';

export const builtinBenchmarks: BenchmarkId[] = ['swe', 'tb2', 'tau', 'sae'];

const harnesses: HarnessDescriptor[] = [kodeAgentSdkHarness, codexHarness, claudeCodeHarness, geminiCliHarness, customAdapterHarness];

export function listHarnesses(): HarnessDescriptor[] {
  return [...harnesses];
}

export function getHarness(id: string): HarnessDescriptor | undefined {
  return harnesses.find((harness) => harness.id === id);
}
