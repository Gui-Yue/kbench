import path from 'path';

import type { BenchmarkId } from '../core/protocol.js';
import { parseModelName, resolveEnvPrefix } from '../harness/drivers/kode_agent_sdk/shared/provider.js';

export interface BenchmarkScriptSpecInput {
  benchmark: BenchmarkId;
  harness: string;
  modelName: string;
  baseUrl?: string;
  runId: string;
  runDir: string;
}

export interface BenchmarkScriptSpec {
  scriptPath: string;
  env: NodeJS.ProcessEnv;
}

export function buildBenchmarkScriptSpec(
  repoRoot: string,
  args: BenchmarkScriptSpecInput,
  baseEnv: NodeJS.ProcessEnv = process.env
): BenchmarkScriptSpec {
  const scriptPath = args.benchmark === 'tau'
    ? path.join(repoRoot, 'scripts', 'bench', 'run-tau-benchmark.sh')
    : path.join(repoRoot, 'scripts', 'bench', 'run-harbor-benchmark.sh');
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    MODEL_NAME: args.modelName,
    KBENCH_HARNESS: args.harness,
    RUN_ID: args.runId,
    NO_REBUILD: baseEnv.NO_REBUILD || '1',
  };

  if (args.baseUrl) {
    const { provider } = parseModelName(args.modelName);
    const prefix = resolveEnvPrefix(provider);
    env[`${prefix}_BASE_URL`] = args.baseUrl;
  }

  if (args.benchmark === 'swe') {
    env.DATASET_NAME = 'swebench-verified';
    env.DATASET_VERSION = '1.0';
    env.KBENCH_BENCHMARK = 'swe';
    env.OUTPUT_DIR = path.dirname(args.runDir);
    env.RUN_ID = path.basename(args.runDir);
  } else if (args.benchmark === 'tb2') {
    env.DATASET_NAME = 'terminal-bench';
    env.DATASET_VERSION = '2.0';
    env.KBENCH_BENCHMARK = 'tb2';
    env.OUTPUT_DIR = path.dirname(args.runDir);
    env.RUN_ID = path.basename(args.runDir);
  } else if (args.benchmark === 'tau') {
    env.OUTPUT_DIR = args.runDir;
  }

  return {
    scriptPath,
    env,
  };
}
