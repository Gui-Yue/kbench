import fs from 'fs';
import path from 'path';

import type { ProbeCheck, ProbeResult } from '../../types.js';
import { claudeCodeHarness } from './manifest.js';
import { inspectCliCommand, runCliCommand, parseJsonLines, listJsonlFiles, includesAll, applyProxyEnv, type ProxyConfig } from '../cli/shared.js';
import { captureGitPatchBaseline, copyFilesPreservingRelativePaths, extractPatchSinceBaseline, materializeCliArtifacts } from '../cli/runtime.js';

export interface ClaudeCodeTaskArgs {
  modelName: string;
  instruction: string;
  workDir: string;
  instanceDir: string;
  timeoutMs?: number;
  baseUrl?: string;
  apiKeyEnv?: string;
  configMode?: 'inherit' | 'isolated';
  proxyUrl?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
}

export interface ClaudeCodeTaskResult {
  ok: boolean;
  exitCode: number;
  finalText?: string;
  patch?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  stdoutPath: string;
  stderrPath: string;
  sessionFiles: string[];
  artifactManifestPath: string;
  traceFiles?: { kind: string; path: string }[];
  error?: string;
}

function getClaudeProbeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.HOME || ''}/.local/bin:${process.env.PATH || ''}`,
  };
}

async function inspectClaudeShell(command: string): Promise<Awaited<ReturnType<typeof inspectCliCommand>>> {
  const env = getClaudeProbeEnv();
  const ttyResult = await inspectCliCommand('script', ['-qec', command, '/dev/null'], env);
  if (ttyResult.ok && ttyResult.combined.trim()) {
    return ttyResult;
  }
  return inspectCliCommand('bash', ['-lc', command], env);
}

export async function probeClaudeCode(): Promise<ProbeResult> {
  const versionProbe = await inspectClaudeShell('claude --version');
  if (!versionProbe.ok) {
    return {
      ok: false,
      command: 'claude',
      errors: [versionProbe.error || 'Failed to inspect claude --version output via shell.'],
    };
  }

  const help = await inspectClaudeShell('claude --help');
  const helpText = help.combined;
  const checks: ProbeCheck[] = [
    {
      id: 'print-mode',
      ok: helpText.includes('--print'),
      detail: helpText.includes('--print')
        ? 'claude exposes --print non-interactive mode.'
        : 'claude help does not expose --print.',
    },
    {
      id: 'output-format',
      ok: helpText.includes('--output-format'),
      detail: helpText.includes('--output-format')
        ? 'claude exposes --output-format.'
        : 'claude help does not expose --output-format.',
    },
    {
      id: 'stream-json',
      ok: includesAll(helpText, ['--output-format', 'stream-json']),
      detail: includesAll(helpText, ['--output-format', 'stream-json'])
        ? 'claude help advertises stream-json output support.'
        : 'claude help does not advertise stream-json output support.',
    },
    {
      id: 'permission-mode',
      ok: helpText.includes('--permission-mode'),
      detail: helpText.includes('--permission-mode')
        ? 'claude exposes --permission-mode.'
        : 'claude help does not expose --permission-mode.',
    },
  ];

  const errors = [
    ...(help.ok ? [] : [help.error || 'Failed to inspect claude help output.']),
    ...checks.filter((check) => !check.ok).map((check) => check.detail),
  ].filter(Boolean);
  return {
    ok: help.ok && errors.length === 0,
    command: 'claude',
    detectedVersion: versionProbe.combined.split(/\r?\n/).map((line) => line.trim()).find(Boolean),
    capabilities: claudeCodeHarness.capabilities,
    checks,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function getDefaultClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured && configured.trim()) {
    return path.resolve(configured);
  }
  return path.join(process.env.HOME || '', '.claude');
}

function resolveClaudeConfigMode(mode?: 'inherit' | 'isolated'): 'inherit' | 'isolated' {
  return mode === 'isolated' ? 'isolated' : 'inherit';
}

function resolveClaudeApiKey(apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv) {
    return process.env[apiKeyEnv];
  }
  return process.env.ANTHROPIC_API_KEY;
}

function resolveClaudeBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl || process.env.ANTHROPIC_BASE_URL;
}

function extractTextFromClaudeEvents(events: any[]): string | undefined {
  const messages: string[] = [];

  for (const event of events) {
    if (event?.type !== 'assistant') continue;
    const message = event?.message;
    if (!message || message.role !== 'assistant') continue;
    const content: Array<{ type?: string; text?: string }> = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map((block) => (block?.type === 'text' && typeof block?.text === 'string' ? block.text : ''))
      .join('')
      .trim();
    if (text) {
      messages.push(text);
    }
  }

  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

function extractUsageFromClaudeEvents(events: any[]): ClaudeCodeTaskResult['usage'] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const usage = event?.message?.usage;
    if (!usage || typeof usage !== 'object') {
      continue;
    }

    const inputTokens = typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.inputTokens === 'number'
        ? usage.inputTokens
        : undefined;
    const outputTokens = typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.outputTokens === 'number'
        ? usage.outputTokens
        : undefined;
    const cachedInputTokens = typeof usage.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : typeof usage.cached_input_tokens === 'number'
        ? usage.cached_input_tokens
        : undefined;

    if (inputTokens !== undefined || outputTokens !== undefined || cachedInputTokens !== undefined) {
      return {
        input_tokens: inputTokens,
        cached_input_tokens: cachedInputTokens,
        output_tokens: outputTokens,
      };
    }
  }
  return undefined;
}

export async function runClaudeCodeTask(args: ClaudeCodeTaskArgs): Promise<ClaudeCodeTaskResult> {
  const artifactsDir = path.join(args.instanceDir, 'artifacts');
  const configMode = resolveClaudeConfigMode(args.configMode);
  const claudeHome = configMode === 'isolated'
    ? path.join(artifactsDir, 'claude-home')
    : getDefaultClaudeConfigDir();
  const stdoutPath = path.join(artifactsDir, 'claude-code.stdout.txt');
  const stderrPath = path.join(artifactsDir, 'claude-code.stderr.txt');
  const patchBaseline = captureGitPatchBaseline(args.workDir);
  const existingSessionFiles = listJsonlFiles(claudeHome);

  if (configMode === 'isolated') {
    fs.mkdirSync(path.join(claudeHome, 'projects', '-app'), { recursive: true });
    fs.mkdirSync(path.join(claudeHome, 'debug'), { recursive: true });
  }

  const anthropicApiKey = resolveClaudeApiKey(args.apiKeyEnv);
  const anthropicBaseUrl = resolveClaudeBaseUrl(args.baseUrl);

  let env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${process.env.HOME || ''}/.local/bin:${process.env.PATH || ''}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    IS_SANDBOX: '1',
  };
  if (configMode === 'isolated' || process.env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = claudeHome;
  }
  if (anthropicApiKey) {
    env.ANTHROPIC_API_KEY = anthropicApiKey;
  }
  if (anthropicBaseUrl) {
    env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
  }
  if (args.modelName) {
    env.ANTHROPIC_MODEL = anthropicBaseUrl
      ? args.modelName
      : args.modelName.split('/').slice(-1)[0];
  }
  env = applyProxyEnv(env, {
    proxyUrl: args.proxyUrl,
    httpProxy: args.httpProxy,
    httpsProxy: args.httpsProxy,
    allProxy: args.allProxy,
    noProxy: args.noProxy,
  } satisfies ProxyConfig);

  const commandResult = await runCliCommand({
    command: 'claude',
    args: [
      '--verbose',
      '--output-format=stream-json',
      '--permission-mode=bypassPermissions',
      '--print',
      '--',
      args.instruction,
    ],
    cwd: args.workDir,
    env,
    stdoutPath,
    stderrPath,
    timeoutMs: args.timeoutMs,
  });

  const events = parseJsonLines(commandResult.stdout);
  const finalText = extractTextFromClaudeEvents(events) || commandResult.stdout.trim() || undefined;
  const usage = extractUsageFromClaudeEvents(events);
  const currentSessionFiles = listJsonlFiles(claudeHome);
  const newSessionFiles = currentSessionFiles.filter((sessionFile) => !existingSessionFiles.includes(sessionFile));
  const materializedSessionRoot = path.join(artifactsDir, 'claude-sessions');
  const sessionFiles = configMode === 'isolated'
    ? currentSessionFiles
    : await copyFilesPreservingRelativePaths(newSessionFiles, claudeHome, materializedSessionRoot);
  const patch = extractPatchSinceBaseline(patchBaseline);
  const { artifactManifestPath, traceFiles } = await materializeCliArtifacts({
    instanceDir: args.instanceDir,
    artifactsDir,
    stdoutPath,
    stderrPath,
    stdoutDescription: 'Raw stdout captured from claude --print.',
    stderrDescription: 'Raw stderr captured from claude --print.',
    patch,
    patchDescription: 'Git diff captured after Claude Code execution.',
    sessionFiles: sessionFiles.map((sessionFile) => ({
      path: sessionFile,
      contentType: 'application/x-ndjson',
      description: 'Claude Code native session JSONL export.',
    })),
    nativeTraceFiles: [
      {
        sourcePath: stdoutPath,
        targetPath: 'claude-stream.jsonl',
        contentType: 'application/x-ndjson',
        description: 'Claude Code stream-json event stream.',
      },
    ],
  });

  return {
    ok: commandResult.exitCode === 0,
    exitCode: commandResult.exitCode,
    finalText,
    patch,
    usage,
    stdoutPath,
    stderrPath,
    sessionFiles,
    artifactManifestPath,
    traceFiles,
    error: commandResult.exitCode === 0 ? undefined : (commandResult.stderr.trim() || commandResult.stdout.trim() || 'claude code failed'),
  };
}
