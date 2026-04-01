import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { runSaeBenchmark, parseBoolean } from '../benchmark/sae/runner.js';
import type { BenchmarkId, SessionSpec, TaskEnvelope } from '../core/protocol.js';
import { materializeArtifactFile, writeArtifactManifest, type ArtifactManifestEntry } from '../core/artifacts.js';
import { createRunLayout, finalizeRun, initializeRun, recordResult } from '../core/run-layout.js';
import type { ArtifactRef, ResultEnvelope, ResultStatus, RunMetadata, TraceRef } from '../core/results.js';
import { summarizeResults } from '../core/results.js';
import { materializeNativeTraceFile, writeNormalizedTrace } from '../core/traces.js';
import { runClaudeCodeTask } from '../harness/drivers/claude_code/index.js';
import { runCodexTask } from '../harness/drivers/codex/index.js';
import { customAdapterHarness } from '../harness/drivers/custom_adapter/manifest.js';
import { probeGeminiCli, runGeminiCliTask } from '../harness/drivers/gemini_cli/index.js';
import { kodeAgentSdkHarness } from '../harness/drivers/kode_agent_sdk/manifest.js';
import { runKodeBenchmark, type LegacyBenchResult } from '../harness/drivers/kode_agent_sdk/task-runner.js';
import { runKodeTauStep, type LegacyStepResult } from '../harness/drivers/kode_agent_sdk/session-runner.js';
import { parseModelName, resolveEnvPrefix } from '../harness/drivers/kode_agent_sdk/shared/provider.js';
import { builtinBenchmarks, getHarness, listHarnesses } from '../harness/registry.js';
import { assertHarnessSelection, validateHarnessSelection } from '../harness/selection.js';
import { generateAdapter, GENERATOR_HINTS, GENERATOR_HINT_DESCRIPTIONS } from '../harness/sdk/generate.js';
import { initAdapter } from '../harness/sdk/init.js';
import { executeAdapterRunner } from '../harness/sdk/runner.js';
import type { AdapterRunnerInput } from '../harness/sdk/protocol.js';
import { loadAdapterManifest, validateAdapter } from '../harness/sdk/validate.js';
import { probeClaudeCode } from '../harness/drivers/claude_code/index.js';
import { probeCodex } from '../harness/drivers/codex/index.js';
import type { HarnessDescriptor } from '../harness/types.js';

interface RunCliArgs {
  benchmark: BenchmarkId;
  harness: string;
  adapterPath?: string;
  instanceId: string;
  runId: string;
  runDir: string;
  modelName?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  configMode?: 'inherit' | 'isolated';
  proxyUrl?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
  workDir?: string;
  storeDir?: string;
  instruction?: string;
  messagesFile?: string;
  toolsFile?: string;
  temperature?: number;
  timeoutMs?: number;
}

interface BenchmarkRunCliArgs {
  benchmark: BenchmarkId;
  harness: string;
  modelName: string;
  baseUrl?: string;
  runId: string;
  runDir: string;
  workDir?: string;
  storeDir?: string;
  timeoutMs?: number;
  saeApiBase: string;
  saeAgentIdFile: string;
  saeApiKeyFile: string;
  saeRegisterIfMissing: boolean;
  saeAgentName?: string;
  saeAgentDescription?: string;
  saeAgentVersion: string;
  saeAgentType: string;
  saePollIntervalMs: number;
}

function probeKodeAgentSdk() {
  return {
    ok: true,
    command: 'internal',
    capabilities: kodeAgentSdkHarness.capabilities,
    checks: [
      {
        id: 'task-mode',
        ok: true,
        detail: 'Built-in task runner is bundled into kbench.',
      },
      {
        id: 'session-mode',
        ok: true,
        detail: 'Built-in session runner is bundled into kbench.',
      },
    ],
  };
}

function requireModelName(args: RunCliArgs): string {
  if (!args.modelName) {
    throw new Error(`Harness ${args.harness} requires --model-name.`);
  }
  return args.modelName;
}

function probeCustomAdapter() {
  return {
    ok: true,
    command: 'adapter-manifest',
    capabilities: customAdapterHarness.capabilities,
    checks: [
      {
        id: 'manifest-required',
        ok: true,
        detail: 'Requires --adapter <path> at runtime.',
      },
      {
        id: 'protocol',
        ok: true,
        detail: 'Executed through the kbench adapter runner protocol.',
      },
    ],
  };
}

function parseFlags(argv: string[]): Map<string, string> {
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
  return values;
}

function requireFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function nowId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function renderHelp(): string {
  return [
    'kbench',
    '',
    'Unified benchmark CLI for SWE, TB2, Tau, SAE, built-in harnesses, and custom adapters.',
    '',
    'Usage:',
    '  kbench <command> [subcommand] [options]',
    '',
    'Command Tree:',
    '  kbench run',
    '  kbench benchmark list',
    '  kbench benchmark run',
    '  kbench harness list',
    '  kbench harness probe',
    '  kbench harness validate',
    '  kbench adapter profiles',
    '  kbench adapter init',
    '  kbench adapter validate',
    '  kbench adapter generate',
    '',
    'Benchmarks:',
    '  swe   Harbor-based SWE benchmark runner',
    '  tb2   Harbor-based Terminal-Bench-2 runner',
    '  tau   Official tau-bench runner / session mode',
    '  sae   Kaggle Standardized Agent Exams runner',
    '',
    'Built-in Harnesses:',
    '  kode-agent-sdk  task: swe,tb2,sae | session: tau',
    '  codex           task only',
    '  claude-code     task only',
    '  gemini-cli      task only',
    '  custom-adapter  task or session, depends on adapter manifest',
    '',
    'Parameter Conventions:',
    '  string   plain text value',
    '  path     filesystem path',
    '  url      http(s) endpoint or proxy URL',
    '  ms       integer milliseconds',
    '  bool     true | false',
    '',
    'Commands:',
    '  kbench run',
    '    Run a single benchmark instance through one harness.',
    '    Required:',
      '      --benchmark <swe|tb2|tau|sae>',
    '      --harness <kode-agent-sdk|codex|claude-code|gemini-cli|custom-adapter>',
    '      --model-name <provider/model>    required except for custom-adapter session/task stubs that do not need a model',
    '    Task-mode inputs:',
    '      --instruction <text>             required for swe/tb2/sae and all task-style CLI harnesses',
    '    Session-mode inputs:',
    '      --messages-file <path>           required for tau',
    '      --tools-file <path>              required for tau',
    '    Custom adapter:',
    '      --adapter <path>                 required when --harness custom-adapter',
    '    Runtime options:',
    '      --run-id <id>                    default: auto-generated',
    '      --instance-id <id>               default: <benchmark>-instance',
    '      --run-dir <path>                 default: ./.kbench/runs/<run-id>',
    '      --workdir <path>                 default: current working directory',
    '      --store-dir <path>               default: harness-specific',
    '      --temperature <number>           optional',
    '      --timeout-ms <ms>                default: benchmark/harness-specific',
    '    Provider / CLI bridge options:',
    '      --base-url <url>',
    '      --api-key-env <ENV_NAME>',
    '      --config-mode <inherit|isolated>',
    '      --proxy-url <url>',
    '      --http-proxy <url>',
    '      --https-proxy <url>',
    '      --all-proxy <url>',
    '      --no-proxy <value>',
    '',
    '  kbench benchmark list',
    '    Print supported benchmark ids.',
    '',
    '  kbench benchmark run',
    '    Run a full benchmark workflow entrypoint.',
    '    Required:',
    '      --benchmark <swe|tb2|tau|sae>',
    '      --model-name <provider/model>',
    '    Optional:',
    '      --harness <id>                   default: kode-agent-sdk',
    '      Note: benchmark run currently supports only --harness kode-agent-sdk.',
    '      --base-url <url>',
    '      --run-id <id>                    default: auto-generated',
    '      --run-dir <path>                 default: ./.kbench/runs/<run-id>',
    '      --workdir <path>',
    '      --store-dir <path>',
    '    SAE-only options:',
    '      --sae-api-base <url>             default: https://www.kaggle.com/api/v1',
    '      --sae-agent-id-file <path>       default: ~/.kaggle-agent-id',
    '      --sae-api-key-file <path>        default: ~/.kaggle-agent-api-key',
    '      --sae-register-if-missing <bool> default: false',
    '      --sae-agent-name <text>',
    '      --sae-agent-description <text>',
    '      --sae-agent-version <text>       default: 1.0',
    '      --sae-agent-type <text>          default: <harness>',
    '      --sae-poll-interval-ms <ms>      default: 2000',
    '      --sae-timeout-ms <ms>            default: 1800000',
    '',
    '  kbench harness list',
    '    Print built-in harness descriptors.',
    '',
    '  kbench harness probe',
    '    Inspect one built-in harness runtime contract.',
    '    Required:',
    '      --harness <id>',
    '',
    '  kbench harness validate',
    '    Validate whether one harness structurally supports one benchmark.',
    '    Required:',
    '      --harness <id>',
    '      --benchmark <swe|tb2|tau|sae>',
    '',
    '  kbench adapter profiles',
    '    Print available adapter-generation hint profiles.',
    '',
    '  kbench adapter init',
    '    Create a new adapter scaffold.',
    '    Required:',
    '      --type <cli|python|node>',
    '      --name <adapter-name>',
    '    Optional:',
    '      --out <directory>',
    '',
    '  kbench adapter validate',
    '    Validate an adapter manifest and entrypoint.',
    '    Required:',
    '      --adapter <path>',
    '',
    '  kbench adapter generate',
    '    Generate a bootstrap adapter from a local repo or lightweight remote identifier.',
    '    Required:',
      '      --repo <path-or-url>',
    '    Optional:',
    '      --source <path-or-url>           alias of --repo',
    '      --out <directory>',
    '      --name <adapter-name>',
    '      --type <cli|python|node>',
    '      --hint <profile>                 one of: generic, cli-harness, codex, claude-code, gemini-cli, langchain-runner, kode-agent-sdk',
    '      --validate <true|false>          default: true',
    '    Notes:',
      '      - Current generation is heuristic and repo-inspection-based.',
      '      - Remote URLs are not fetched automatically.',
      '      - Output is a bootstrap scaffold, not a production-ready adapter.',
    '',
    'Parameter Reference:',
    '  Global command selection:',
    '    command / subcommand',
    '      type: string',
    '      required: yes',
    '      applies to: all invocations except bare --help',
    '      values: run | benchmark list | benchmark run | harness list | harness probe | harness validate | adapter profiles | adapter init | adapter validate | adapter generate',
    '',
    '  kbench run parameters:',
    '    --benchmark',
    '      type: string',
    '      required: yes',
    '      applies to: kbench run',
    '      values: swe | tb2 | tau | sae',
    '',
    '    --harness',
    '      type: string',
    '      required: yes',
    '      applies to: kbench run',
    '      values: kode-agent-sdk | codex | claude-code | gemini-cli | custom-adapter',
    '',
    '    --model-name',
    '      type: string',
    '      required: yes for built-in harnesses; usually expected for real custom adapters too',
    '      applies to: kbench run',
    '      format: <provider>/<model>',
    '',
    '    --instruction',
    '      type: string',
    '      required: yes for task-mode execution',
    '      applies to: swe | tb2 | sae, and all task-style CLI harnesses',
    '',
    '    --messages-file',
    '      type: path',
    '      required: yes for tau',
    '      applies to: kbench run --benchmark tau',
    '',
    '    --tools-file',
    '      type: path',
    '      required: yes for tau',
    '      applies to: kbench run --benchmark tau',
    '',
    '    --adapter',
    '      type: path',
    '      required: yes when --harness custom-adapter',
    '      applies to: kbench run --harness custom-adapter',
    '',
    '    --run-id',
    '      type: string',
    '      required: no',
    '      default: auto-generated',
    '      applies to: kbench run',
    '',
    '    --instance-id',
    '      type: string',
    '      required: no',
    '      default: <benchmark>-instance',
    '      applies to: kbench run',
    '',
    '    --run-dir',
    '      type: path',
    '      required: no',
    '      default: ./.kbench/runs/<run-id>',
    '      applies to: kbench run',
    '',
    '    --workdir',
    '      type: path',
    '      required: no',
    '      default: current working directory',
    '      applies to: kbench run and benchmark run',
    '',
    '    --store-dir',
    '      type: path',
    '      required: no',
    '      default: harness-specific',
    '      applies to: kbench run and benchmark run',
    '',
    '    --temperature',
    '      type: string/number',
    '      required: no',
    '      default: harness-specific',
    '      applies to: kbench run; currently relevant to kode-agent-sdk tau/session flows and adapters that read config.temperature',
    '',
    '    --timeout-ms',
    '      type: ms',
    '      required: no',
    '      default: derived from benchmark and harness',
    '      applies to: kbench run',
    '',
    '    --base-url',
    '      type: url',
    '      required: no',
    '      default: provider/harness default',
    '      applies to: kbench run and benchmark run',
    '      notes: for benchmark run, forwarded only through the kode-agent-sdk path',
    '',
    '    --api-key-env',
    '      type: string',
    '      required: no',
    '      default: harness default',
    '      applies to: CLI harnesses and custom adapters that consume config.apiKeyEnv',
    '',
    '    --config-mode',
    '      type: string',
    '      required: no',
    '      values: inherit | isolated',
    '      default: inherit unless harness overrides internally',
    '      applies to: CLI harnesses and custom adapters that consume config.configMode',
    '',
    '    --proxy-url',
    '      type: url',
    '      required: no',
    '      applies to: CLI harnesses and custom adapters that consume config.proxyUrl',
    '',
    '    --http-proxy',
    '      type: url',
    '      required: no',
    '      applies to: CLI harnesses and custom adapters',
    '',
    '    --https-proxy',
    '      type: url',
    '      required: no',
    '      applies to: CLI harnesses and custom adapters',
    '',
    '    --all-proxy',
    '      type: url',
    '      required: no',
    '      applies to: CLI harnesses and custom adapters',
    '',
    '    --no-proxy',
    '      type: string',
    '      required: no',
    '      applies to: CLI harnesses and custom adapters',
    '',
    '  kbench benchmark run parameters:',
    '    --benchmark',
    '      type: string',
    '      required: yes',
    '      applies to: benchmark run',
    '      values: swe | tb2 | tau | sae',
    '',
    '    --harness',
    '      type: string',
    '      required: no',
    '      default: kode-agent-sdk',
    '      applies to: benchmark run',
    '      notes: current implementation accepts only kode-agent-sdk',
    '',
    '    --model-name',
    '      type: string',
    '      required: yes',
    '      applies to: benchmark run',
    '      format: <provider>/<model>',
    '',
    '    --base-url',
    '      type: url',
    '      required: no',
    '      applies to: benchmark run',
    '',
    '    --run-id',
    '      type: string',
    '      required: no',
    '      default: auto-generated as benchmark-<benchmark>-...',
    '      applies to: benchmark run',
    '',
    '    --run-dir',
    '      type: path',
    '      required: no',
    '      default: ./.kbench/runs/<run-id>',
    '      applies to: benchmark run',
    '',
    '    --sae-api-base',
    '      type: url',
    '      required: no',
    '      default: https://www.kaggle.com/api/v1',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-agent-id-file',
    '      type: path',
    '      required: no',
    '      default: ~/.kaggle-agent-id',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-api-key-file',
    '      type: path',
    '      required: no',
    '      default: ~/.kaggle-agent-api-key',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-register-if-missing',
    '      type: bool',
    '      required: no',
    '      default: false',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-agent-name',
    '      type: string',
    '      required: no',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-agent-description',
    '      type: string',
    '      required: no',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-agent-version',
    '      type: string',
    '      required: no',
    '      default: 1.0',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-agent-type',
    '      type: string',
    '      required: no',
    '      default: <harness>',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-poll-interval-ms',
    '      type: ms',
    '      required: no',
    '      default: 2000',
    '      applies to: benchmark run --benchmark sae',
    '',
    '    --sae-timeout-ms',
    '      type: ms',
    '      required: no',
    '      default: 1800000',
    '      applies to: benchmark run --benchmark sae',
    '',
    '  kbench harness probe / validate parameters:',
    '    --harness',
    '      type: string',
    '      required: yes',
    '      applies to: harness probe | harness validate',
    '',
    '    --benchmark',
    '      type: string',
    '      required: yes for harness validate',
    '      applies to: harness validate',
    '      values: swe | tb2 | tau | sae',
    '',
    '  kbench adapter init parameters:',
    '    --type',
    '      type: string',
    '      required: yes',
    '      values: cli | python | node',
    '',
    '    --name',
    '      type: string',
    '      required: yes',
    '',
    '    --out',
    '      type: path',
    '      required: no',
    '',
    '  kbench adapter validate parameters:',
    '    --adapter',
    '      type: path',
    '      required: yes',
    '',
    '  kbench adapter generate parameters:',
    '    --repo',
    '      type: path|string',
    '      required: yes',
    '      applies to: adapter generate',
    '      notes: local paths are inspected directly; remote URLs are treated as lightweight identifiers only',
    '',
    '    --source',
    '      type: path|string',
    '      required: no',
    '      applies to: adapter generate',
    '      notes: alias of --repo',
    '',
    '    --out',
    '      type: path',
    '      required: no',
    '      applies to: adapter generate',
    '',
    '    --name',
    '      type: string',
    '      required: no',
    '      applies to: adapter generate',
    '',
    '    --type',
    '      type: string',
    '      required: no',
    '      values: cli | python | node',
    '      applies to: adapter generate',
    '',
    '    --hint',
    '      type: string',
    '      required: no',
    '      values: generic | cli-harness | codex | claude-code | gemini-cli | langchain-runner | kode-agent-sdk',
    '      applies to: adapter generate',
    '',
    '    --validate',
    '      type: bool',
    '      required: no',
    '      default: true',
    '      applies to: adapter generate',
    '',
    'Environment / External Configuration:',
    '  kbench runtime',
    '    KBENCH_REPO_ROOT                internal repo root used by bin/kbench',
    '',
    '  provider credentials used by benchmark flows and harness runtimes',
    '    OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_API',
    '    ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL',
    '    GEMINI_API_KEY / GEMINI_BASE_URL',
    '',
    '  generated cli-harness adapters',
    '    KBENCH_CLI_COMMAND',
    '    KBENCH_CLI_PROMPT_FLAG',
    '    KBENCH_CLI_MODEL_FLAG',
    '    KBENCH_CLI_OUTPUT_FLAG',
    '    KBENCH_CLI_OUTPUT_VALUE',
    '    KBENCH_CLI_EXTRA_ARGS',
    '',
    '  benchmark shell bridges',
    '    NO_REBUILD                      when benchmark run invokes Harbor/Tau scripts',
    '',
    'Default Timeout Policy:',
    '  tau                     5 minutes',
    '  swe/tb2 + CLI harness   30 minutes',
    '  swe/tb2 + kode-agent-sdk 20 minutes',
    '  sae                     30 minutes',
    '',
    'Examples:',
    '  kbench benchmark list',
    '  kbench benchmark run --benchmark swe --harness kode-agent-sdk --model-name glm/glm-5',
    '  kbench benchmark run --benchmark sae --harness kode-agent-sdk --model-name glm/glm-5 --sae-register-if-missing false',
    '  kbench run --benchmark swe --harness kode-agent-sdk --model-name openai/gpt-4.1-mini --instruction "Fix the failing test"',
    '  kbench run --benchmark swe --harness codex --model-name openai/gpt-5.3-codex --base-url https://apikey.soxio.me/openai --api-key-env OPENAI_API_KEY --instruction "Fix the bug"',
    '  kbench run --benchmark swe --harness gemini-cli --model-name gemini/gemini-2.5-pro --api-key-env GEMINI_API_KEY --config-mode isolated --proxy-url http://127.0.0.1:7897 --instruction "Fix the bug"',
    '  kbench run --benchmark tau --harness kode-agent-sdk --model-name glm/glm-5 --messages-file ./messages.json --tools-file ./tools.json',
    '  kbench run --benchmark swe --harness custom-adapter --adapter ./my-adapter --instruction "Fix the bug"',
    '  kbench harness probe --harness codex',
    '  kbench harness validate --harness codex --benchmark swe',
    '  kbench adapter profiles',
    '  kbench adapter init --type node --name my-runner --out ./generated/my-runner',
    '  kbench adapter validate --adapter ./generated/my-runner',
    '  kbench adapter generate --repo ../my-agent --hint langchain-runner --out ./generated/my-agent-adapter',
    '  kbench adapter generate --repo ../my-cli-agent --hint cli-harness --out ./generated/my-cli-agent-adapter',
  ].join('\n');
}

function getRepoRoot(): string {
  return path.resolve(process.env.KBENCH_REPO_ROOT || process.cwd());
}

function getDefaultTimeoutMs(benchmark: BenchmarkId, harness: string): number | undefined {
  if (benchmark === 'tau') {
    return 5 * 60 * 1000;
  }

  if (benchmark === 'swe' || benchmark === 'tb2') {
    if (harness === 'codex' || harness === 'claude-code' || harness === 'gemini-cli') {
      return 30 * 60 * 1000;
    }
    return 20 * 60 * 1000;
  }

  if (benchmark === 'sae') {
    return 30 * 60 * 1000;
  }

  return undefined;
}

function parseRunArgs(argv: string[]): RunCliArgs {
  const values = parseFlags(argv);
  const benchmark = values.get('benchmark') as BenchmarkId | undefined;
  const harness = values.get('harness');
  const modelName = values.get('model-name');

  if (!benchmark || !['swe', 'tb2', 'tau', 'sae'].includes(benchmark)) {
    throw new Error('Missing or invalid --benchmark. Expected one of: swe, tb2, tau, sae.');
  }
  if (!harness) {
    throw new Error('Missing --harness.');
  }
  if (harness !== 'custom-adapter' && !modelName) {
    throw new Error('Missing --model-name.');
  }

  const runId = values.get('run-id') || nowId('run');
  const instanceId = values.get('instance-id') || `${benchmark}-instance`;
  const runDir = path.resolve(values.get('run-dir') || path.join(process.cwd(), '.kbench', 'runs', runId));
  const explicitTimeoutMs = values.get('timeout-ms') ? Number(values.get('timeout-ms')) : undefined;
  const configModeValue = values.get('config-mode');
  if (configModeValue && configModeValue !== 'inherit' && configModeValue !== 'isolated') {
    throw new Error('Invalid --config-mode. Expected one of: inherit, isolated.');
  }

  return {
    benchmark,
    harness,
    adapterPath: values.get('adapter') ? path.resolve(values.get('adapter') as string) : undefined,
    instanceId,
    runId,
    runDir,
    modelName,
    baseUrl: values.get('base-url'),
    apiKeyEnv: values.get('api-key-env'),
    configMode: configModeValue as RunCliArgs['configMode'] | undefined,
    proxyUrl: values.get('proxy-url'),
    httpProxy: values.get('http-proxy'),
    httpsProxy: values.get('https-proxy'),
    allProxy: values.get('all-proxy'),
    noProxy: values.get('no-proxy'),
    workDir: values.get('workdir') ? path.resolve(values.get('workdir') as string) : undefined,
    storeDir: values.get('store-dir') ? path.resolve(values.get('store-dir') as string) : undefined,
    instruction: values.get('instruction'),
    messagesFile: values.get('messages-file') ? path.resolve(values.get('messages-file') as string) : undefined,
    toolsFile: values.get('tools-file') ? path.resolve(values.get('tools-file') as string) : undefined,
    temperature: values.get('temperature') ? Number(values.get('temperature')) : undefined,
    timeoutMs: explicitTimeoutMs ?? getDefaultTimeoutMs(benchmark, harness),
  };
}

function parseBenchmarkRunArgs(argv: string[]): BenchmarkRunCliArgs {
  const values = parseFlags(argv);
  const benchmark = values.get('benchmark') as BenchmarkId | undefined;
  const harness = values.get('harness') || 'kode-agent-sdk';
  const modelName = values.get('model-name');

  if (!benchmark || !builtinBenchmarks.includes(benchmark)) {
    throw new Error('benchmark run requires --benchmark <swe|tb2|tau|sae>.');
  }
  if (!modelName) {
    throw new Error('benchmark run requires --model-name <provider/model>.');
  }

  const runId = values.get('run-id') || nowId(`benchmark-${benchmark}`);
  const runDir = path.resolve(values.get('run-dir') || path.join(process.cwd(), '.kbench', 'runs', runId));
  return {
    benchmark,
    harness,
    modelName,
    baseUrl: values.get('base-url'),
    runId,
    runDir,
    workDir: values.get('workdir') ? path.resolve(values.get('workdir') as string) : undefined,
    storeDir: values.get('store-dir') ? path.resolve(values.get('store-dir') as string) : undefined,
    timeoutMs: values.get('sae-timeout-ms') ? Number(values.get('sae-timeout-ms')) : undefined,
    saeApiBase: values.get('sae-api-base') || 'https://www.kaggle.com/api/v1',
    saeAgentIdFile: values.get('sae-agent-id-file') || '~/.kaggle-agent-id',
    saeApiKeyFile: values.get('sae-api-key-file') || '~/.kaggle-agent-api-key',
    saeRegisterIfMissing: parseBoolean(values.get('sae-register-if-missing'), false),
    saeAgentName: values.get('sae-agent-name'),
    saeAgentDescription: values.get('sae-agent-description'),
    saeAgentVersion: values.get('sae-agent-version') || '1.0',
    saeAgentType: values.get('sae-agent-type') || harness,
    saePollIntervalMs: values.get('sae-poll-interval-ms') ? Number(values.get('sae-poll-interval-ms')) : 2000,
  };
}

async function spawnCommand(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runBenchmarkCommand(argv: string[]): Promise<void> {
  const args = parseBenchmarkRunArgs(argv);
  if (args.harness !== 'kode-agent-sdk') {
    throw new Error(`benchmark run currently supports only --harness kode-agent-sdk. Received: ${args.harness}`);
  }

  if (args.benchmark === 'sae') {
    const outcome = await runSaeBenchmark({
      runId: args.runId,
      runDir: args.runDir,
      harness: args.harness,
      modelName: args.modelName,
      baseUrl: args.baseUrl,
      workDir: args.workDir,
      storeDir: args.storeDir,
      saeApiBase: args.saeApiBase,
      saeAgentIdFile: args.saeAgentIdFile,
      saeApiKeyFile: args.saeApiKeyFile,
      saeRegisterIfMissing: args.saeRegisterIfMissing,
      saeAgentName: args.saeAgentName,
      saeAgentDescription: args.saeAgentDescription,
      saeAgentVersion: args.saeAgentVersion,
      saeAgentType: args.saeAgentType,
      saeTimeoutMs: args.timeoutMs,
      saePollIntervalMs: args.saePollIntervalMs,
    });

    process.stdout.write(`${JSON.stringify({
      completed: outcome.completed,
      runId: outcome.runId,
      runDir: outcome.runDir,
      profileUrl: outcome.profileUrl,
      benchmarkError: outcome.benchmarkError,
      benchmarkResult: outcome.summary.benchmarkResult,
    }, null, 2)}\n`);
    process.exitCode = outcome.completed ? 0 : 2;
    return;
  }

  const repoRoot = getRepoRoot();
  const scriptPath = args.benchmark === 'tau'
    ? path.join(repoRoot, 'scripts', 'bench', 'run-tau-benchmark.sh')
    : path.join(repoRoot, 'scripts', 'bench', 'run-harbor-benchmark.sh');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODEL_NAME: args.modelName,
    KBENCH_HARNESS: args.harness,
    NO_REBUILD: process.env.NO_REBUILD || '1',
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
  } else if (args.benchmark === 'tb2') {
    env.DATASET_NAME = 'terminal-bench';
    env.DATASET_VERSION = '2.0';
    env.KBENCH_BENCHMARK = 'tb2';
  }

  const exitCode = await spawnCommand('bash', [scriptPath], {
    cwd: repoRoot,
    env,
  });
  process.exitCode = exitCode;
}

function classifyTaskStatus(result: LegacyBenchResult): ResultStatus {
  if (result.ok) return 'ok';
  if (result.status === 'timeout') return 'timeout';
  if (result.status === 'error') return 'agent_error';
  if (result.gitDiffNameOnly && result.gitDiffNameOnly.length === 0 && !result.text) {
    return 'unresolved';
  }
  return 'agent_error';
}

function classifyStepStatus(result: LegacyStepResult): ResultStatus {
  return result.ok ? 'ok' : 'agent_error';
}

function normalizeTaskResult(args: RunCliArgs, result: LegacyBenchResult, startedAt: string, endedAt: string): ResultEnvelope {
  return {
    benchmark: args.benchmark,
    harness: args.harness,
    instanceId: args.instanceId,
    ok: result.ok,
    status: classifyTaskStatus(result),
    failureKind: result.status,
    startedAt,
    endedAt,
    elapsedMs: result.elapsedMs,
    finalText: result.text,
    nativeResult: result,
    error: result.error
      ? {
          message: result.error,
          stack: result.stack,
        }
      : undefined,
  };
}

function normalizeStepResult(args: RunCliArgs, result: LegacyStepResult, startedAt: string, endedAt: string): ResultEnvelope {
  const actionText = result.action?.type === 'respond'
    ? result.action.text
    : result.action?.type === 'tool_call'
      ? `${result.action.tool_call?.name}(${JSON.stringify(result.action.tool_call?.arguments ?? {})})`
      : undefined;

  return {
    benchmark: args.benchmark,
    harness: args.harness,
    instanceId: args.instanceId,
    ok: result.ok,
    status: classifyStepStatus(result),
    failureKind: result.action?.type,
    startedAt,
    endedAt,
    elapsedMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    finalText: result.action?.type === 'respond' ? result.action.text : undefined,
    action: actionText,
    usage: result.usage
      ? {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        }
      : undefined,
    nativeResult: result,
    error: result.error
      ? {
          message: result.error,
        }
      : undefined,
  };
}

async function runKodeAgentSdk(args: RunCliArgs): Promise<ResultEnvelope> {
  const startedAt = new Date().toISOString();

  if (args.benchmark === 'tau') {
    if (!args.messagesFile || !args.toolsFile) {
      throw new Error('Tau benchmark requires --messages-file and --tools-file.');
    }

    const result = await runKodeTauStep({
      modelName: requireModelName(args),
      messagesFile: args.messagesFile,
      toolsFile: args.toolsFile,
      temperature: args.temperature,
    });
    return normalizeStepResult(args, result, startedAt, new Date().toISOString());
  }

  if (!args.instruction) {
    throw new Error(`${args.benchmark} benchmark requires --instruction.`);
  }

  const workDir = args.workDir || process.cwd();
  const storeDir = args.storeDir || path.join(workDir, '.kode-bench');
  const result = await runKodeBenchmark({
    instruction: args.instruction,
    modelName: requireModelName(args),
    workDir,
    storeDir,
  });

  return normalizeTaskResult(args, result, startedAt, new Date().toISOString());
}

async function runCliHarnessTask(args: RunCliArgs): Promise<ResultEnvelope> {
  if (args.benchmark === 'tau') {
    throw new Error(`${args.harness} is not yet supported for session/tau mode.`);
  }
  if (!args.instruction) {
    throw new Error(`${args.harness} requires --instruction.`);
  }

  const startedAt = new Date().toISOString();
  const instanceDir = path.join(args.runDir, 'instances', args.instanceId);
  let result:
    | Awaited<ReturnType<typeof runCodexTask>>
    | Awaited<ReturnType<typeof runClaudeCodeTask>>
    | Awaited<ReturnType<typeof runGeminiCliTask>>;

  if (args.harness === 'codex') {
    result = await runCodexTask({
      modelName: requireModelName(args),
      instruction: args.instruction,
      workDir: args.workDir || process.cwd(),
      instanceDir,
      timeoutMs: args.timeoutMs,
      baseUrl: args.baseUrl,
      apiKeyEnv: args.apiKeyEnv,
      configMode: args.configMode,
      proxyUrl: args.proxyUrl,
      httpProxy: args.httpProxy,
      httpsProxy: args.httpsProxy,
      allProxy: args.allProxy,
      noProxy: args.noProxy,
    });
  } else if (args.harness === 'claude-code') {
    result = await runClaudeCodeTask({
      modelName: requireModelName(args),
      instruction: args.instruction,
      workDir: args.workDir || process.cwd(),
      instanceDir,
      timeoutMs: args.timeoutMs,
      baseUrl: args.baseUrl,
      apiKeyEnv: args.apiKeyEnv,
      configMode: args.configMode,
      proxyUrl: args.proxyUrl,
      httpProxy: args.httpProxy,
      httpsProxy: args.httpsProxy,
      allProxy: args.allProxy,
      noProxy: args.noProxy,
    });
  } else if (args.harness === 'gemini-cli') {
    result = await runGeminiCliTask({
      modelName: requireModelName(args),
      instruction: args.instruction,
      workDir: args.workDir || process.cwd(),
      instanceDir,
      timeoutMs: args.timeoutMs,
      baseUrl: args.baseUrl,
      apiKeyEnv: args.apiKeyEnv,
      configMode: args.configMode,
      proxyUrl: args.proxyUrl,
      httpProxy: args.httpProxy,
      httpsProxy: args.httpsProxy,
      allProxy: args.allProxy,
      noProxy: args.noProxy,
    });
  } else {
    throw new Error(`Unsupported CLI harness: ${args.harness}`);
  }

  const status: ResultStatus = result.exitCode === 124
    ? 'timeout'
    : result.ok
      ? 'ok'
      : args.harness === 'gemini-cli' && (result.exitCode === 41 || /auth method|api key|google_genai_use|vertexai/i.test(result.error || ''))
        ? 'provider_error'
        : 'agent_error';
  const traceFiles = 'traceFiles' in result && Array.isArray(result.traceFiles)
    ? result.traceFiles
    : undefined;

  return {
    benchmark: args.benchmark,
    harness: args.harness,
    instanceId: args.instanceId,
    ok: result.ok,
    status,
    failureKind: result.exitCode === 0
      ? undefined
      : status === 'provider_error' && args.harness === 'gemini-cli'
        ? 'missing_or_invalid_auth'
        : `exit_${result.exitCode}`,
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    finalText: result.finalText,
    patch: result.patch,
    usage: result.usage
      ? {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cacheTokens: result.usage.cached_input_tokens,
        }
      : undefined,
    artifacts: [
      { kind: 'stdout', path: result.stdoutPath },
      { kind: 'stderr', path: result.stderrPath },
      { kind: 'manifest', path: result.artifactManifestPath },
      ...result.sessionFiles.map((sessionFile) => ({ kind: 'session', path: sessionFile })),
    ],
    trace: traceFiles && traceFiles.length > 0 ? traceFiles : undefined,
    nativeResult: result,
    error: result.error
      ? {
          message: result.error,
        }
      : undefined,
  };
}

function toAdapterDescriptor(loaded: Awaited<ReturnType<typeof loadAdapterManifest>>): HarnessDescriptor {
  if (!loaded.manifest) {
    throw new Error('Adapter manifest validation failed.');
  }
  return {
    id: loaded.manifest.id,
    kind: loaded.manifest.kind,
    description: `Custom adapter loaded from ${loaded.manifestPath}`,
    supportedBenchmarks: loaded.manifest.supportedBenchmarks || [],
    capabilities: loaded.manifest.capabilities,
  };
}

function createTaskEnvelope(args: RunCliArgs): TaskEnvelope {
  if (!args.instruction) {
    throw new Error(`${args.benchmark} benchmark requires --instruction.`);
  }
  return {
    benchmark: args.benchmark,
    instanceId: args.instanceId,
    instruction: args.instruction,
    env: {
      workdir: args.workDir || process.cwd(),
      repoPath: args.workDir || process.cwd(),
      sandbox: {
        type: 'host',
      },
    },
  };
}

function createSessionSpec(args: RunCliArgs): SessionSpec {
  if (!args.messagesFile || !args.toolsFile) {
    throw new Error('Tau benchmark requires --messages-file and --tools-file.');
  }
  return {
    benchmark: args.benchmark,
    instanceId: args.instanceId,
    env: {
      workdir: args.workDir || process.cwd(),
      repoPath: args.workDir || process.cwd(),
      sandbox: {
        type: 'host',
      },
    },
    initialObservation: {
      messagesFile: args.messagesFile,
      toolsFile: args.toolsFile,
    },
    actionSpace: {
      type: 'adapter-session',
    },
  };
}

function normalizeCustomAdapterResult(
  args: RunCliArgs,
  startedAt: string,
  result: Awaited<ReturnType<typeof executeAdapterRunner>>,
  outputs: {
    artifacts: ArtifactRef[];
    trace: TraceRef[];
  }
): ResultEnvelope {
  const output = result.output;
  if (!output) {
    return {
      benchmark: args.benchmark,
      harness: args.harness,
      instanceId: args.instanceId,
      ok: false,
      status: 'invalid_adapter',
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs: 0,
      error: {
        message: result.error || 'Custom adapter did not return a valid output payload.',
      },
      nativeResult: result,
    };
  }

  return {
    benchmark: args.benchmark,
    harness: args.harness,
    instanceId: args.instanceId,
    ok: output.ok,
    status: output.status,
    failureKind: output.failureKind,
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: output.elapsedMs,
    finalText: output.finalText,
    action: output.action,
    patch: output.patch,
    usage: output.usage,
    benchmarkResult: output.benchmarkResult,
    trace: outputs.trace.length > 0 ? outputs.trace : undefined,
    artifacts: outputs.artifacts,
    nativeResult: output.nativeResult ?? result,
    error: output.error,
  };
}

async function materializeCustomAdapterOutputs(
  args: RunCliArgs,
  loaded: Awaited<ReturnType<typeof loadAdapterManifest>>,
  result: Awaited<ReturnType<typeof executeAdapterRunner>>
): Promise<{
  artifacts: ArtifactRef[];
  trace: TraceRef[];
}> {
  const instanceDir = path.join(args.runDir, 'instances', args.instanceId);
  const instanceArtifactsDir = path.join(instanceDir, 'artifacts');
  const manifestEntries: ArtifactManifestEntry[] = [];
  const traceRefs: TraceRef[] = [];

  await fs.promises.mkdir(instanceArtifactsDir, { recursive: true });

  const stdoutPath = path.join(instanceArtifactsDir, 'adapter.stdout.txt');
  await fs.promises.writeFile(stdoutPath, result.stdout, 'utf-8');
  manifestEntries.push({
    id: 'stdout',
    kind: 'stdout',
    path: stdoutPath,
    contentType: 'text/plain',
    description: 'Raw stdout captured from the custom adapter runner.',
  });

  const stderrPath = path.join(instanceArtifactsDir, 'adapter.stderr.txt');
  await fs.promises.writeFile(stderrPath, result.stderr, 'utf-8');
  manifestEntries.push({
    id: 'stderr',
    kind: 'stderr',
    path: stderrPath,
    contentType: 'text/plain',
    description: 'Raw stderr captured from the custom adapter runner.',
  });

  if (result.output?.patch) {
    const patchPath = path.join(instanceArtifactsDir, 'patch.diff');
    await fs.promises.writeFile(patchPath, result.output.patch, 'utf-8');
    manifestEntries.push({
      id: 'patch',
      kind: 'patch',
      path: patchPath,
      contentType: 'text/x-diff',
      description: 'Patch returned by the custom adapter runner.',
    });
  }

  const adapterArtifacts = result.output?.artifacts || [];
  for (let index = 0; index < adapterArtifacts.length; index += 1) {
    const artifact = adapterArtifacts[index];
    const sourcePath = path.isAbsolute(artifact.path)
      ? artifact.path
      : path.resolve(loaded.adapterDir, artifact.path);
    const relativeName = path.isAbsolute(artifact.path)
      ? path.basename(artifact.path)
      : artifact.path.replace(/^\.?\//, '');
    const targetPath = await materializeArtifactFile(
      sourcePath,
      instanceArtifactsDir,
      path.join('adapter-files', relativeName)
    ).catch(() => sourcePath);

    manifestEntries.push({
      id: `adapter-artifact-${index + 1}`,
      kind: (artifact.kind as ArtifactManifestEntry['kind']) || 'other',
      path: targetPath,
      contentType: artifact.contentType,
      description: artifact.description || 'Artifact returned by the custom adapter runner.',
    });
  }

  if (Array.isArray(result.output?.trace?.normalized) && result.output.trace.normalized.length > 0) {
    const normalizedTrace = await writeNormalizedTrace(instanceDir, result.output.trace.normalized);
    traceRefs.push(normalizedTrace);
    manifestEntries.push({
      id: 'trace-normalized',
      kind: 'trajectory',
      path: normalizedTrace.path,
      contentType: 'application/json',
      description: 'Normalized trajectory exported by the custom adapter runner.',
    });
  }

  const nativeTraceArtifacts = result.output?.trace?.native || [];
  for (let index = 0; index < nativeTraceArtifacts.length; index += 1) {
    const traceArtifact = nativeTraceArtifacts[index];
    const sourcePath = path.isAbsolute(traceArtifact.path)
      ? traceArtifact.path
      : path.resolve(loaded.adapterDir, traceArtifact.path);
    const relativeName = path.isAbsolute(traceArtifact.path)
      ? path.basename(traceArtifact.path)
      : traceArtifact.path.replace(/^\.?\//, '');
    const traceRef = await materializeNativeTraceFile(
      instanceDir,
      sourcePath,
      relativeName
    ).catch(() => ({
      kind: 'native',
      path: sourcePath,
    }));

    traceRefs.push(traceRef);
    manifestEntries.push({
      id: `native-trace-${index + 1}`,
      kind: 'trajectory',
      path: traceRef.path,
      contentType: traceArtifact.contentType,
      description: traceArtifact.description || 'Native trace returned by the custom adapter runner.',
    });
  }

  const manifestPath = await writeArtifactManifest(instanceArtifactsDir, manifestEntries);

  return {
    artifacts: [
      { kind: 'stdout', path: stdoutPath },
      { kind: 'stderr', path: stderrPath },
      ...(result.output?.patch ? [{ kind: 'patch', path: path.join(instanceArtifactsDir, 'patch.diff') }] : []),
      ...manifestEntries
        .filter((entry) => entry.id.startsWith('adapter-artifact-'))
        .map((entry) => ({ kind: entry.kind, path: entry.path })),
      { kind: 'manifest', path: manifestPath },
    ],
    trace: traceRefs,
  };
}

async function runCustomAdapter(args: RunCliArgs): Promise<ResultEnvelope> {
  if (!args.adapterPath) {
    throw new Error('custom-adapter requires --adapter <path>.');
  }

  const loaded = await loadAdapterManifest(args.adapterPath);
  if (!loaded.manifest || !loaded.schema.ok) {
    throw new Error(`Invalid adapter manifest at ${loaded.manifestPath}.`);
  }
  const descriptor = toAdapterDescriptor(loaded);
  assertHarnessSelection(descriptor, args.benchmark);

  const mode = args.benchmark === 'tau' ? 'session' : 'task';
  const taskEnvelope = mode === 'task' ? createTaskEnvelope(args) : undefined;
  const sessionSpec = mode === 'session' ? createSessionSpec(args) : undefined;
  const env = taskEnvelope?.env || sessionSpec?.env;
  const input: AdapterRunnerInput = mode === 'task'
    ? {
        mode: 'task',
        task: taskEnvelope as TaskEnvelope,
        env: env!,
        config: {
          modelName: args.modelName,
          timeoutMs: args.timeoutMs,
          temperature: args.temperature,
          baseUrl: args.baseUrl,
          apiKeyEnv: args.apiKeyEnv,
          proxyUrl: args.proxyUrl,
          httpProxy: args.httpProxy,
          httpsProxy: args.httpsProxy,
          allProxy: args.allProxy,
          noProxy: args.noProxy,
          workDir: args.workDir,
          storeDir: args.storeDir,
        },
      }
    : {
        mode: 'session',
        session: sessionSpec as SessionSpec,
        env: env!,
        config: {
          modelName: args.modelName,
          timeoutMs: args.timeoutMs,
          temperature: args.temperature,
          baseUrl: args.baseUrl,
          apiKeyEnv: args.apiKeyEnv,
          proxyUrl: args.proxyUrl,
          httpProxy: args.httpProxy,
          httpsProxy: args.httpsProxy,
          allProxy: args.allProxy,
          noProxy: args.noProxy,
          workDir: args.workDir,
          storeDir: args.storeDir,
        },
      };

  const startedAt = new Date().toISOString();
  const result = await executeAdapterRunner(
    loaded.manifest,
    loaded.entryPath,
    input,
    loaded.adapterDir
  );
  const outputs = await materializeCustomAdapterOutputs(args, loaded, result);
  return normalizeCustomAdapterResult(args, startedAt, result, outputs);
}

async function runCommand(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);
  const harness = getHarness(args.harness);
  if (!harness) {
    throw new Error(`Unknown harness: ${args.harness}`);
  }
  if (args.harness !== 'custom-adapter') {
    assertHarnessSelection(harness, args.benchmark);
  }

  const layout = createRunLayout(args.runDir, args.runId);
  const metadata: RunMetadata = {
    runId: args.runId,
    benchmark: args.benchmark,
    harness: args.harness,
    model: args.modelName,
    startedAt: new Date().toISOString(),
    concurrency: 1,
    benchmarkConfig: {
      instanceId: args.instanceId,
    },
    harnessConfig: {
      workDir: args.workDir,
      storeDir: args.storeDir,
      baseUrl: args.baseUrl,
      apiKeyEnv: args.apiKeyEnv,
      configMode: args.configMode,
      proxyUrl: args.proxyUrl,
      httpProxy: args.httpProxy,
      httpsProxy: args.httpsProxy,
      allProxy: args.allProxy,
      noProxy: args.noProxy,
    },
  };

  await initializeRun(layout, metadata);
  const result = args.harness === 'kode-agent-sdk'
    ? await runKodeAgentSdk(args)
    : args.harness === 'custom-adapter'
      ? await runCustomAdapter(args)
      : await runCliHarnessTask(args);
  metadata.endedAt = new Date().toISOString();
  await recordResult(layout, result);
  await finalizeRun(layout, metadata, summarizeResults(args.runId, [result]));

  if (result.finalText) {
    process.stdout.write(`${result.finalText}\n`);
  }
  process.exitCode = result.ok ? 0 : 2;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${renderHelp()}\n`);
    return;
  }

  if (command !== 'run') {
    if (command === 'benchmark' && rest[0] === 'list') {
      process.stdout.write(`${builtinBenchmarks.join('\n')}\n`);
      return;
    }

    if (command === 'benchmark' && rest[0] === 'run') {
      await runBenchmarkCommand(rest.slice(1));
      return;
    }

    if (command === 'harness' && rest[0] === 'list') {
      const lines = listHarnesses().map((harness) => `${harness.id}\t${harness.kind}\t${harness.supportedBenchmarks.join(',')}\t${harness.description}`);
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }

    if (command === 'harness' && rest[0] === 'probe') {
      const harnessArgIndex = rest.findIndex((token) => token === '--harness');
      if (harnessArgIndex === -1 || !rest[harnessArgIndex + 1]) {
        throw new Error('harness probe requires --harness <id>.');
      }
      const harness = getHarness(rest[harnessArgIndex + 1]);
      if (!harness) {
        throw new Error(`Unknown harness: ${rest[harnessArgIndex + 1]}`);
      }
      let runtimeProbe: unknown = harness;
      if (harness.id === 'codex') {
        runtimeProbe = { descriptor: harness, probe: await probeCodex() };
      } else if (harness.id === 'claude-code') {
        runtimeProbe = { descriptor: harness, probe: await probeClaudeCode() };
      } else if (harness.id === 'gemini-cli') {
        runtimeProbe = { descriptor: harness, probe: await probeGeminiCli() };
      } else if (harness.id === 'kode-agent-sdk') {
        runtimeProbe = { descriptor: harness, probe: probeKodeAgentSdk() };
      } else if (harness.id === 'custom-adapter') {
        runtimeProbe = { descriptor: harness, probe: probeCustomAdapter() };
      }
      process.stdout.write(`${JSON.stringify(runtimeProbe, null, 2)}\n`);
      return;
    }

    if (command === 'harness' && rest[0] === 'validate') {
      const harnessArgIndex = rest.findIndex((token) => token === '--harness');
      const benchmarkArgIndex = rest.findIndex((token) => token === '--benchmark');
      if (harnessArgIndex === -1 || !rest[harnessArgIndex + 1]) {
        throw new Error('harness validate requires --harness <id>.');
      }
      if (benchmarkArgIndex === -1 || !rest[benchmarkArgIndex + 1]) {
        throw new Error('harness validate requires --benchmark <swe|tb2|tau|sae>.');
      }
      const harness = getHarness(rest[harnessArgIndex + 1]);
      const benchmark = rest[benchmarkArgIndex + 1] as BenchmarkId;
      if (!harness) {
        throw new Error(`Unknown harness: ${rest[harnessArgIndex + 1]}`);
      }
      if (!builtinBenchmarks.includes(benchmark)) {
        throw new Error(`Unknown benchmark: ${benchmark}`);
      }
      const validation = validateHarnessSelection(harness, benchmark);
      process.stdout.write(`${JSON.stringify({ descriptor: harness, validation }, null, 2)}\n`);
      process.exitCode = validation.ok ? 0 : 2;
      return;
    }

    if (command === 'adapter' && rest[0] === 'profiles') {
      const lines = GENERATOR_HINTS.map((hint) => `${hint}\t${GENERATOR_HINT_DESCRIPTIONS[hint]}`);
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }

    if (command === 'adapter' && rest[0] === 'init') {
      const values = parseFlags(rest.slice(1));
      const type = requireFlag(values, 'type') as 'cli' | 'python' | 'node';
      const name = requireFlag(values, 'name');
      if (!['cli', 'python', 'node'].includes(type)) {
        throw new Error('adapter init currently supports --type cli|python|node.');
      }
      const result = await initAdapter({
        type,
        name,
        outDir: values.get('out') ? path.resolve(values.get('out') as string) : undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (command === 'adapter' && rest[0] === 'validate') {
      const values = parseFlags(rest.slice(1));
      const adapterPath = requireFlag(values, 'adapter');
      const report = await validateAdapter(adapterPath);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 2;
      return;
    }

    if (command === 'adapter' && rest[0] === 'generate') {
      const values = parseFlags(rest.slice(1));
      const repo = values.get('repo') || values.get('source');
      if (!repo) {
        throw new Error('adapter generate requires --repo <path-or-url>.');
      }
      const type = values.get('type');
      if (type && !['cli', 'python', 'node'].includes(type)) {
        throw new Error('adapter generate currently supports --type cli|python|node.');
      }
      const hint = values.get('hint');
      if (hint && !GENERATOR_HINTS.includes(hint as (typeof GENERATOR_HINTS)[number])) {
        throw new Error(`adapter generate --hint must be one of: ${GENERATOR_HINTS.join(', ')}.`);
      }
      const result = await generateAdapter({
        repo,
        outDir: values.get('out') ? path.resolve(values.get('out') as string) : undefined,
        name: values.get('name'),
        type: type as 'cli' | 'python' | 'node' | undefined,
        hint: hint as (typeof GENERATOR_HINTS)[number] | undefined,
        validate: values.get('validate') !== 'false',
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.validation && !result.validation.ok ? 2 : 0;
      return;
    }

    if (command === 'adapter') {
      throw new Error('Unsupported adapter subcommand. Expected one of: profiles, init, validate, generate.');
    }

    throw new Error(`Unsupported command: ${command}`);
  }

  await runCommand(rest);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
