import fs from 'fs';
import os from 'os';
import path from 'path';

import { createRunLayout, finalizeRun, initializeRun, recordResult, writeJson } from '../../core/run-layout.js';
import type { ResultEnvelope, ResultStatus, RunMetadata, SummaryResult } from '../../core/results.js';
import { summarizeResults } from '../../core/results.js';
import { runKodeBenchmark, type LegacyBenchResult } from '../../harness/drivers/kode_agent_sdk/task-runner.js';
import { parseModelName, resolveEnvPrefix } from '../../harness/drivers/kode_agent_sdk/shared/provider.js';
import { SaeApiError, SaeClient } from './client.js';
import type {
  SaeAgentCredentials,
  SaeAgentProfile,
  SaeBenchmarkConfig,
  SaeBenchmarkOutcome,
  SaeQuestion,
  SaeSubmissionResult,
  SaeSubmissionStart,
} from './types.js';

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProfileUrl(agentId: string): string {
  return `https://www.kaggle.com/experimental/sae/${agentId}`;
}

function classifyBenchmarkFailure(error: unknown): { failureKind: string; message: string } {
  if (error instanceof SaeApiError) {
    if (error.status === 401 || error.status === 403) {
      return { failureKind: 'auth_error', message: error.message };
    }
    if (error.status === 404) {
      return { failureKind: 'feature_not_available', message: error.message };
    }
    if (error.status === 412) {
      return { failureKind: 'submission_limit_reached', message: error.message };
    }
    if (error.status === 429) {
      return { failureKind: 'rate_limited', message: error.message };
    }
    return { failureKind: `http_${error.status}`, message: error.message };
  }

  if (error instanceof Error) {
    return { failureKind: 'benchmark_runtime_error', message: error.message };
  }

  return { failureKind: 'benchmark_runtime_error', message: String(error) };
}

function classifyQuestionStatus(result: LegacyBenchResult): ResultStatus {
  if (result.ok && result.text?.trim()) {
    return 'ok';
  }
  if (result.status === 'timeout') {
    return 'timeout';
  }

  const message = `${result.error || ''}\n${result.stack || ''}`.toLowerCase();
  if (
    message.includes('_api_key')
    || message.includes('api error')
    || message.includes('rate limit')
    || message.includes('provider')
    || message.includes('fetch failed')
    || message.includes('timed out')
  ) {
    return 'provider_error';
  }

  return 'agent_error';
}

function normalizeQuestionResult(
  questionId: string,
  result: LegacyBenchResult,
  startedAt: string,
  endedAt: string
): ResultEnvelope {
  const status = classifyQuestionStatus(result);
  return {
    benchmark: 'sae',
    harness: 'kode-agent-sdk',
    instanceId: questionId,
    ok: status === 'ok',
    status,
    failureKind: result.status || (status === 'provider_error' ? 'provider_error' : undefined),
    startedAt,
    endedAt,
    elapsedMs: result.elapsedMs,
    finalText: result.text?.trim(),
    nativeResult: result,
    error: result.error
      ? {
          message: result.error,
          stack: result.stack,
        }
      : undefined,
  };
}

function buildQuestionInstruction(question: SaeQuestion): string {
  return [
    'You are answering one Kaggle Standardized Agent Exam question.',
    'Follow the question formatting instructions exactly.',
    'Return only the final answer that should be submitted for grading.',
    'Do not include explanation, analysis, markdown fences, or extra prefixes unless the question explicitly asks for them.',
    '',
    `Question ID: ${question.id}`,
    'Question:',
    question.text,
  ].join('\n');
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const value = await fs.promises.readFile(filePath, 'utf-8');
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeSecretFile(filePath: string, value: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${value.trim()}\n`, { encoding: 'utf-8', mode: 0o600 });
  await fs.promises.chmod(filePath, 0o600);
}

function buildGeneratedAgentName(config: SaeBenchmarkConfig): string {
  const suffix = new Date().toISOString().replace(/[^0-9]/g, '').slice(-10);
  return `kbench-${config.saeAgentType}-${suffix}`;
}

async function loadOrRegisterCredentials(
  client: SaeClient,
  config: SaeBenchmarkConfig,
  artifactDir: string
): Promise<{ credentials: SaeAgentCredentials; registration?: SaeAgentProfile }> {
  const agentIdPath = expandHome(config.saeAgentIdFile);
  const apiKeyPath = expandHome(config.saeApiKeyFile);
  const [agentId, apiToken] = await Promise.all([
    readFileIfExists(agentIdPath),
    readFileIfExists(apiKeyPath),
  ]);

  if (agentId && apiToken) {
    return {
      credentials: {
        agentId,
        apiToken,
      },
    };
  }

  if (!config.saeRegisterIfMissing) {
    throw new Error(
      [
        'Missing SAE credentials.',
        `Expected files: ${agentIdPath} and ${apiKeyPath}.`,
        'Pass --sae-register-if-missing true to register a new agent automatically.',
      ].join(' ')
    );
  }

  const registration = await client.registerAgent({
    name: config.saeAgentName || buildGeneratedAgentName(config),
    model: config.modelName,
    version: config.saeAgentVersion,
    description: config.saeAgentDescription,
    agentType: config.saeAgentType,
  });
  if (!registration.agentId || !registration.apiToken) {
    throw new Error('SAE registration succeeded but did not return agentId/apiToken.');
  }

  await Promise.all([
    writeSecretFile(agentIdPath, registration.agentId),
    writeSecretFile(apiKeyPath, registration.apiToken),
  ]);
  await writeJson(path.join(artifactDir, 'registration.json'), registration);

  return {
    credentials: {
      agentId: registration.agentId,
      apiToken: registration.apiToken,
    },
    registration,
  };
}

async function ensureCompletedSubmission(
  client: SaeClient,
  submission: SaeSubmissionResult,
  apiToken: string,
  pollIntervalMs: number,
  deadlineAt: number
): Promise<SaeSubmissionResult> {
  let current = submission;
  while (!/COMPLETED|TIMED_OUT|FAILED/i.test(current.status)) {
    if (Date.now() >= deadlineAt) {
      throw new Error('SAE submission polling exceeded configured deadline.');
    }
    await sleep(pollIntervalMs);
    current = await client.getSubmission(current.submissionId, apiToken);
  }
  return current;
}

function mergeSummary(summary: SummaryResult, benchmarkResult: Record<string, unknown>): SummaryResult {
  return {
    ...summary,
    benchmarkResult,
  };
}

function normalizePositiveMs(value: number | undefined, label: string, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} is required.`);
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number of milliseconds.`);
  }
  return value;
}

function withTemporaryBaseUrl<T>(modelName: string, baseUrl: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!baseUrl) {
    return fn();
  }

  const { provider } = parseModelName(modelName);
  const key = `${resolveEnvPrefix(provider)}_BASE_URL`;
  const previous = process.env[key];
  process.env[key] = baseUrl;

  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = previous;
  });
}

export async function runSaeBenchmark(config: SaeBenchmarkConfig): Promise<SaeBenchmarkOutcome> {
  const saeTimeoutMs = normalizePositiveMs(config.saeTimeoutMs, 'saeTimeoutMs', 30 * 60 * 1000);
  const saePollIntervalMs = normalizePositiveMs(config.saePollIntervalMs, 'saePollIntervalMs');
  const layout = createRunLayout(config.runDir, config.runId);
  const artifactDir = path.join(layout.runDir, 'artifacts', 'sae');
  const metadata: RunMetadata = {
    runId: config.runId,
    benchmark: 'sae',
    harness: config.harness,
    model: config.modelName,
    provider: parseModelName(config.modelName).provider,
    baseUrl: config.baseUrl,
    startedAt: new Date().toISOString(),
    concurrency: 1,
    benchmarkConfig: {
      apiBase: config.saeApiBase,
      registerIfMissing: config.saeRegisterIfMissing,
      agentIdFile: expandHome(config.saeAgentIdFile),
      apiKeyFile: expandHome(config.saeApiKeyFile),
      timeoutMs: saeTimeoutMs,
      pollIntervalMs: saePollIntervalMs,
    },
    harnessConfig: {
      workDir: config.workDir,
      storeDir: config.storeDir,
    },
  };

  await initializeRun(layout, metadata);
  await fs.promises.mkdir(artifactDir, { recursive: true });

  const client = new SaeClient({
    apiBase: config.saeApiBase,
    requestTimeoutMs: 60_000,
  });
  const results: ResultEnvelope[] = [];
  let submission: SaeSubmissionResult | undefined;
  let profile: SaeAgentProfile | undefined;
  let credentials: SaeAgentCredentials | undefined;

  try {
    const deadlineAt = Date.now() + saeTimeoutMs;
    const credentialState = await loadOrRegisterCredentials(client, config, artifactDir);
    credentials = credentialState.credentials;

    const started = await client.startSubmission(credentials.apiToken);
    await writeJson(path.join(artifactDir, 'start_submission.json'), started);
    await writeJson(path.join(artifactDir, 'questions.json'), started.questions);

    const answers: Record<string, string> = {};
    await withTemporaryBaseUrl(config.modelName, config.baseUrl, async () => {
      for (const question of started.questions) {
        if (Date.now() >= deadlineAt) {
          throw new Error('SAE benchmark exceeded configured exam deadline before all questions were answered.');
        }

        const questionStartedAt = new Date().toISOString();
        const result = await runKodeBenchmark({
          instruction: buildQuestionInstruction(question),
          modelName: config.modelName,
          workDir: config.workDir || process.cwd(),
          storeDir: path.join(layout.instancesDir, question.id, '.kode-bench'),
          taskProfile: 'qa-exam',
        });
        const envelope = normalizeQuestionResult(question.id, result, questionStartedAt, new Date().toISOString());
        answers[question.id] = envelope.finalText || '';
        results.push(envelope);
        await recordResult(layout, envelope);
      }
    });

    await writeJson(path.join(artifactDir, 'answers.json'), { answers });

    submission = await client.submitAnswers(started.submissionId, { answers }, credentials.apiToken);
    await writeJson(path.join(artifactDir, 'submit_answers.json'), submission);
    submission = await ensureCompletedSubmission(
      client,
      submission,
      credentials.apiToken,
      saePollIntervalMs,
      deadlineAt
    );
    await writeJson(path.join(artifactDir, 'final_submission.json'), submission);

    profile = await client.getAgent(credentials.agentId, credentials.apiToken);
    await writeJson(path.join(artifactDir, 'agent_profile.json'), profile);

    metadata.endedAt = new Date().toISOString();
    const summary = mergeSummary(summarizeResults(config.runId, results), {
      submissionId: submission.submissionId,
      score: submission.score,
      maxScore: submission.maxScore,
      percentage: submission.percentage,
      passed: submission.passed,
      certificateId: submission.certificateId,
      agentId: credentials.agentId,
      profileUrl: buildProfileUrl(credentials.agentId),
    });
    await finalizeRun(layout, metadata, summary);

    return {
      completed: true,
      runId: config.runId,
      runDir: layout.runDir,
      summary,
      profileUrl: buildProfileUrl(credentials.agentId),
      submission,
      agent: profile,
    };
  } catch (error) {
    metadata.endedAt = new Date().toISOString();
    const classified = classifyBenchmarkFailure(error);
    const summary = mergeSummary(summarizeResults(config.runId, results), {
      error: classified.message,
      failureKind: classified.failureKind,
      agentId: credentials?.agentId,
      submissionId: submission?.submissionId,
      profileUrl: credentials?.agentId ? buildProfileUrl(credentials.agentId) : undefined,
    });
    await writeJson(path.join(artifactDir, 'benchmark_error.json'), {
      failureKind: classified.failureKind,
      message: classified.message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    await finalizeRun(layout, metadata, summary);

    return {
      completed: false,
      runId: config.runId,
      runDir: layout.runDir,
      summary,
      profileUrl: credentials?.agentId ? buildProfileUrl(credentials.agentId) : undefined,
      submission,
      agent: profile,
      benchmarkError: classified,
    };
  }
}

export { parseBoolean };
