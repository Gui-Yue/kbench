import type { EnvSpec, SessionSpec, TaskEnvelope } from '../../core/protocol.js';
import type { ResultStatus, UsageSummary } from '../../core/results.js';
import type { TraceEvent } from '../../core/traces.js';

export interface AdapterExecutionConfig {
  modelName?: string;
  timeoutMs?: number;
  temperature?: number;
  baseUrl?: string;
  apiKeyEnv?: string;
  proxyUrl?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
  workDir?: string;
  storeDir?: string;
  extra?: Record<string, unknown>;
}

export interface AdapterTaskRunnerInput {
  mode: 'task';
  task: TaskEnvelope;
  env: EnvSpec;
  config: AdapterExecutionConfig;
}

export interface AdapterSessionRunnerInput {
  mode: 'session';
  session: SessionSpec;
  env: EnvSpec;
  config: AdapterExecutionConfig;
}

export type AdapterRunnerInput =
  | AdapterTaskRunnerInput
  | AdapterSessionRunnerInput;

export const ADAPTER_INPUT_PATH_ENV = 'KBENCH_ADAPTER_INPUT';

export interface AdapterArtifactRef {
  kind: string;
  path: string;
  contentType?: string;
  description?: string;
}

export interface AdapterTraceBundle {
  normalized?: TraceEvent[];
  native?: AdapterArtifactRef[];
}

export interface AdapterRunnerOutput {
  ok: boolean;
  status: ResultStatus;
  failureKind?: string;
  finalText?: string;
  action?: string;
  patch?: string;
  elapsedMs: number;
  usage?: UsageSummary;
  artifacts?: AdapterArtifactRef[];
  trace?: AdapterTraceBundle;
  benchmarkResult?: Record<string, unknown>;
  nativeResult?: unknown;
  error?: {
    type?: string;
    message: string;
    stack?: string;
  };
}
