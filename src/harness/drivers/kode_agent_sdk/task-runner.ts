import fs from 'fs';
import path from 'path';

import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
  builtin,
  type ModelProvider,
} from '@shareai-lab/kode-sdk';

import {
  GlmBenchFallbackProvider,
  NonStreamingProvider,
  RetryingProvider,
  createKodeProvider,
  describeError,
  parseModelName,
  readRetryConfig,
  shouldUseNonStreamingProvider,
} from './shared/provider.js';

export interface KodeBenchmarkRunArgs {
  instruction: string;
  modelName: string;
  workDir: string;
  storeDir: string;
  taskProfile?: 'repo-task' | 'qa-exam';
}

interface KodeBenchmarkCliArgs extends KodeBenchmarkRunArgs {
  outputPath: string;
}

export interface LegacyBenchResult {
  ok: boolean;
  status?: string;
  text?: string;
  rounds?: number;
  elapsedMs: number;
  workDir: string;
  storeDir: string;
  modelName: string;
  gitStatus?: string;
  gitDiffStat?: string;
  gitDiffNameOnly?: string[];
  monitorErrors?: Array<{
    severity: 'info' | 'warn' | 'error';
    phase: 'model' | 'tool' | 'system' | 'lifecycle';
    message: string;
    detail?: any;
  }>;
  error?: string;
  stack?: string;
}

function parseArgs(argv: string[]): KodeBenchmarkCliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, next);
    i += 1;
  }

  const workDir = path.resolve(values.get('workdir') || process.cwd());
  const storeDir = path.resolve(values.get('store-dir') || path.join(workDir, '.kode-bench'));
  const outputPath = path.resolve(values.get('output') || path.join(storeDir, 'result.json'));
  const instruction = values.get('instruction') || process.env.KODE_BENCH_INSTRUCTION;
  const modelName = values.get('model-name') || process.env.KODE_BENCH_MODEL_NAME;

  if (!instruction) {
    throw new Error('Missing benchmark instruction. Pass --instruction or set KODE_BENCH_INSTRUCTION.');
  }
  if (!modelName) {
    throw new Error('Missing model name. Pass --model-name in provider/model format.');
  }

  return {
    instruction,
    modelName,
    workDir,
    storeDir,
    outputPath,
  };
}

function isMeaningfulText(text?: string): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (!normalized) return false;

  const lowSignalPrefixes = [
    "i'll investigate",
    'i will investigate',
    "i'll analyze",
    'i will analyze',
    "let me start",
    'let me first',
    'let me look',
    'let me search',
    'let me inspect',
    'now i understand',
  ];

  const lower = normalized.toLowerCase();
  if (lowSignalPrefixes.some((prefix) => lower.startsWith(prefix))) {
    return false;
  }

  return true;
}

function hasMeaningfulDiff(diagnostics: Pick<LegacyBenchResult, 'gitDiffNameOnly'>): boolean {
  return Boolean(diagnostics.gitDiffNameOnly && diagnostics.gitDiffNameOnly.length > 0);
}

function hasFatalMonitorErrors(errors?: LegacyBenchResult['monitorErrors']): boolean {
  return Boolean(errors?.some((event) => event.severity === 'error'));
}

function summarizeMonitorErrors(errors?: LegacyBenchResult['monitorErrors']): string | undefined {
  if (!errors || errors.length === 0) return undefined;
  return errors.map((event) => `[${event.phase}/${event.severity}] ${event.message}`).join('\n');
}

function registerBenchTools(registry: ToolRegistry): string[] {
  const toolInstances = [...builtin.fs(), ...builtin.bash(), ...builtin.todo()]
    .filter(Boolean)
    .filter((tool) => tool.name !== 'fs_multi_edit');
  for (const tool of toolInstances) {
    registry.register(tool.name, () => tool);
  }
  return toolInstances.map((tool) => tool.name);
}

function buildSystemPrompt(taskProfile: NonNullable<KodeBenchmarkRunArgs['taskProfile']>): string {
  if (taskProfile === 'qa-exam') {
    return [
      'You are taking a standardized agent exam.',
      'Answer the question directly and follow formatting instructions exactly.',
      'Return only the final answer text unless the question explicitly asks for explanation or a specific wrapper format.',
      'Do not add markdown code fences unless the question explicitly requires them.',
      'Do not invent external facts when unsure; respond as carefully and minimally as possible.',
    ].join(' ');
  }

  return [
    'You are an autonomous software engineer working inside a benchmark task environment.',
    'Use the available filesystem and bash tools to inspect code, edit files, and run targeted verification.',
    'Do not stop at high-level analysis. If you have not used tools or changed files yet, continue working.',
    'Read relevant files before changing them.',
    'Prefer minimal patches that solve the task correctly.',
    'Before finishing, run the most relevant tests or checks you can afford.',
    'Keep the final answer brief and include what changed and what you verified.',
  ].join(' ');
}

async function collectGitDiagnostics(agent: Agent): Promise<Pick<LegacyBenchResult, 'gitStatus' | 'gitDiffStat' | 'gitDiffNameOnly'>> {
  const sandbox = (agent as any).sandbox;
  if (!sandbox?.exec) {
    return {};
  }

  const [status, diffStat, diffNameOnly] = await Promise.all([
    sandbox.exec('git status --short', { timeoutMs: 20000 }).catch(() => ({ stdout: '', stderr: '', code: 1 })),
    sandbox.exec('git diff --stat', { timeoutMs: 20000 }).catch(() => ({ stdout: '', stderr: '', code: 1 })),
    sandbox.exec('git diff --name-only', { timeoutMs: 20000 }).catch(() => ({ stdout: '', stderr: '', code: 1 })),
  ]);

  return {
    gitStatus: status.stdout.trim() || status.stderr.trim() || undefined,
    gitDiffStat: diffStat.stdout.trim() || diffStat.stderr.trim() || undefined,
    gitDiffNameOnly: diffNameOnly.stdout
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean),
  };
}

function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function writeResult(outputPath: string, result: LegacyBenchResult): Promise<void> {
  ensureDirFor(outputPath);
  await fs.promises.writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

function createRuntimeProvider(modelName: string): ModelProvider {
  const provider = createKodeProvider(modelName);
  const reliableProvider = new RetryingProvider(provider, readRetryConfig());
  const fallbackProvider = parseModelName(modelName).provider === 'glm'
    ? new GlmBenchFallbackProvider(reliableProvider)
    : reliableProvider;

  return shouldUseNonStreamingProvider(modelName)
    ? new NonStreamingProvider(fallbackProvider)
    : fallbackProvider;
}

export async function runKodeBenchmark(args: KodeBenchmarkRunArgs): Promise<LegacyBenchResult> {
  const taskProfile = args.taskProfile || 'repo-task';
  const provider = createRuntimeProvider(args.modelName);
  const store = new JSONStore(args.storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();
  const toolNames = taskProfile === 'repo-task' ? registerBenchTools(tools) : [];

  templates.register({
    id: 'kode-benchmark',
    systemPrompt: buildSystemPrompt(taskProfile),
    tools: toolNames,
    permission: { mode: 'auto' },
    runtime: {
      todo: taskProfile === 'repo-task'
        ? { enabled: true, reminderOnStart: true, remindIntervalSteps: 8 }
        : { enabled: false, reminderOnStart: false, remindIntervalSteps: 0 },
    },
  });

  const start = Date.now();
  let agent: Agent | undefined;
  let stopMonitoring: (() => void) | undefined;

  try {
    fs.mkdirSync(args.storeDir, { recursive: true });

    agent = await Agent.create(
      {
        templateId: 'kode-benchmark',
        model: provider,
        sandbox: {
          kind: 'local',
          workDir: args.workDir,
          enforceBoundary: true,
          watchFiles: false,
        },
      },
      {
        store,
        templateRegistry: templates,
        sandboxFactory,
        toolRegistry: tools,
      }
    );

    const maxRounds = Number.parseInt(
      process.env.KODE_BENCH_MAX_ROUNDS || (taskProfile === 'qa-exam' ? '1' : '4'),
      10
    );
    const monitorErrors: NonNullable<LegacyBenchResult['monitorErrors']> = [];
    stopMonitoring = agent.on('error', (event) => {
      monitorErrors.push({
        severity: event.severity,
        phase: event.phase,
        message: event.message,
        detail: event.detail,
      });
    });

    let reply = await agent.chat(args.instruction);
    let diagnostics = await collectGitDiagnostics(agent);
    let rounds = 1;

    while (
      taskProfile === 'repo-task' &&
      reply.status === 'ok' &&
      rounds < maxRounds &&
      !hasFatalMonitorErrors(monitorErrors) &&
      !hasMeaningfulDiff(diagnostics) &&
      !isMeaningfulText(reply.text)
    ) {
      reply = await agent.chat(
        [
          'You have not made any file changes yet.',
          'Do not stop at analysis.',
          'Use the filesystem and bash tools now to inspect the repository, edit the necessary files, and run a targeted verification command before you finish.',
        ].join(' ')
      );
      diagnostics = await collectGitDiagnostics(agent);
      rounds += 1;
    }

    return {
      ok: reply.status === 'ok' && !hasFatalMonitorErrors(monitorErrors),
      status: hasFatalMonitorErrors(monitorErrors) ? 'error' : reply.status,
      text: reply.text,
      rounds,
      elapsedMs: Date.now() - start,
      workDir: args.workDir,
      storeDir: args.storeDir,
      modelName: args.modelName,
      monitorErrors: monitorErrors.length > 0 ? monitorErrors : undefined,
      error: summarizeMonitorErrors(monitorErrors),
      stack: monitorErrors.find((event) => typeof event.detail?.stack === 'string')?.detail?.stack,
      ...diagnostics,
    };
  } catch (error: any) {
    const diagnostics = agent ? await collectGitDiagnostics(agent).catch(() => ({})) : {};
    return {
      ok: false,
      elapsedMs: Date.now() - start,
      workDir: args.workDir,
      storeDir: args.storeDir,
      modelName: args.modelName,
      error: error?.message || describeError(error),
      stack: error?.stack,
      ...diagnostics,
    };
  } finally {
    stopMonitoring?.();
    await (agent as any)?.sandbox?.dispose?.();
  }
}

export async function runKodeBenchmarkCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await runKodeBenchmark(args);
  await writeResult(args.outputPath, result);
  if (result.text) {
    process.stdout.write(`${result.text}\n`);
  }
  process.exitCode = result.ok ? 0 : 2;
}
