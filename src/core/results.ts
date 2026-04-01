import type { BenchmarkId } from './protocol.js';

export type ResultStatus =
  | 'ok'
  | 'unresolved'
  | 'timeout'
  | 'agent_error'
  | 'provider_error'
  | 'infra_error'
  | 'invalid_adapter'
  | 'unsupported_capability'
  | 'benchmark_error';

export interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
}

export interface TraceRef {
  kind: string;
  path: string;
}

export interface ArtifactRef {
  kind: string;
  path: string;
}

export interface ResultEnvelope {
  benchmark: BenchmarkId;
  harness: string;
  instanceId: string;
  ok: boolean;
  status: ResultStatus;
  failureKind?: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  finalText?: string;
  action?: string;
  patch?: string;
  usage?: UsageSummary;
  benchmarkResult?: Record<string, unknown>;
  nativeResult?: unknown;
  trace?: TraceRef[];
  artifacts?: ArtifactRef[];
  error?: {
    type?: string;
    message: string;
    stack?: string;
  };
}

export interface RunMetadata {
  runId: string;
  benchmark: BenchmarkId;
  harness: string;
  harnessVersion?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  startedAt: string;
  endedAt?: string;
  concurrency: number;
  retryPolicy?: Record<string, unknown>;
  benchmarkConfig?: Record<string, unknown>;
  harnessConfig?: Record<string, unknown>;
}

export interface SummaryResult {
  runId: string;
  total: number;
  passed: number;
  unresolved: number;
  errored: number;
  accuracy?: number;
  passAtK?: Record<string, number>;
  byStatus: Record<string, number>;
  benchmarkResult?: Record<string, unknown>;
}

export function summarizeResults(runId: string, results: ResultEnvelope[]): SummaryResult {
  const byStatus: Record<string, number> = {};
  let passed = 0;
  let unresolved = 0;
  let errored = 0;

  for (const result of results) {
    byStatus[result.status] = (byStatus[result.status] || 0) + 1;
    if (result.ok) {
      passed += 1;
    } else if (result.status === 'unresolved') {
      unresolved += 1;
    } else {
      errored += 1;
    }
  }

  return {
    runId,
    total: results.length,
    passed,
    unresolved,
    errored,
    accuracy: results.length > 0 ? passed / results.length : 0,
    byStatus,
  };
}
