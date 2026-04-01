import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TraceRef } from '../../../core/results.js';
import { type TraceEvent } from '../../../core/traces.js';
import type { ProbeCheck, ProbeResult } from '../../types.js';
import { applyProxyEnv, parseJsonLines, runCliCommand, type ProxyConfig } from '../cli/shared.js';
import { captureGitPatchBaseline, copyFilesPreservingRelativePaths, extractPatchSinceBaseline, materializeCliArtifacts } from '../cli/runtime.js';
import { geminiCliHarness } from './manifest.js';

export interface GeminiCliTaskArgs {
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

export interface GeminiCliTaskResult {
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
  traceFiles?: TraceRef[];
  error?: string;
}

interface GeminiStreamEvent {
  type?: string;
  timestamp?: string;
  role?: 'user' | 'assistant';
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  output?: string;
  error?: {
    type?: string;
    message?: string;
  };
  message?: string;
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
  };
}

function getDefaultGeminiHome(): string {
  const configured = process.env.GEMINI_CLI_HOME;
  if (configured && configured.trim()) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.gemini-cli-home');
}

function resolveGeminiConfigMode(mode?: 'inherit' | 'isolated'): 'inherit' | 'isolated' {
  return mode === 'inherit' ? 'inherit' : 'isolated';
}

function resolveGeminiApiKey(apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv && process.env[apiKeyEnv]) {
    return process.env[apiKeyEnv];
  }
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

function resolveGeminiBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl || process.env.GEMINI_BASE_URL || process.env.GOOGLE_GEMINI_BASE_URL;
}

function ensureGeminiHome(homeDir: string): void {
  fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.config'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.cache'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.local', 'share'), { recursive: true });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toScriptArgs(args: string[]): string[] {
  const command = args.map((arg) => shellEscape(arg)).join(' ');
  return ['-qec', command, '/dev/null'];
}

function buildGeminiEnv(homeDir: string, apiKey?: string, baseUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  };
  if (apiKey) {
    env.GEMINI_API_KEY = apiKey;
  }
  if (baseUrl) {
    env.GEMINI_BASE_URL = baseUrl;
    env.GOOGLE_GEMINI_BASE_URL = baseUrl;
  }
  return env;
}

function listFilesRecursively(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const found: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        found.push(fullPath);
      }
    }
  }
  walk(rootDir);
  return found.sort();
}

function filterGeminiArtifactFiles(files: string[]): string[] {
  return files.filter((filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.includes('/.gemini/')) return false;
    if (normalized.endsWith('/oauth_creds.json')) return false;
    if (normalized.endsWith('/settings.json')) return false;
    if (normalized.endsWith('/projects.json')) return false;
    return normalized.includes('/.gemini/history/') || normalized.includes('/.gemini/tmp/');
  });
}

function extractTextFromGeminiEvents(events: GeminiStreamEvent[]): string | undefined {
  const assistantDeltas = events
    .filter((event) => event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string')
    .map((event) => event.content || '');
  const text = assistantDeltas.join('').trim();
  return text || undefined;
}

function extractUsageFromGeminiEvents(events: GeminiStreamEvent[]): GeminiCliTaskResult['usage'] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const stats = events[index]?.stats;
    if (!stats || typeof stats !== 'object') continue;
    return {
      input_tokens: typeof stats.input_tokens === 'number' ? stats.input_tokens : undefined,
      cached_input_tokens: typeof stats.cached === 'number' ? stats.cached : undefined,
      output_tokens: typeof stats.output_tokens === 'number' ? stats.output_tokens : undefined,
    };
  }
  return undefined;
}

function toTraceEvents(events: GeminiStreamEvent[]): TraceEvent[] {
  return events.map((event) => {
    const timestamp = event.timestamp || new Date().toISOString();
    if (event.type === 'message') {
      return {
        type: 'message',
        ts: timestamp,
        source: event.role === 'assistant' ? 'agent' : 'benchmark',
        role: event.role,
        message: event.content,
      };
    }
    if (event.type === 'tool_use') {
      return {
        type: 'tool_call',
        ts: timestamp,
        source: 'agent',
        toolName: event.tool_name,
        callId: event.tool_id,
        extra: event.parameters ? { parameters: event.parameters } : undefined,
      };
    }
    if (event.type === 'tool_result') {
      return {
        type: 'tool_result',
        ts: timestamp,
        source: 'runtime',
        callId: event.tool_id,
        message: event.output || event.error?.message,
        extra: {
          status: event.status,
          error: event.error,
        },
      };
    }
    if (event.type === 'result') {
      return {
        type: 'result',
        ts: timestamp,
        source: 'runtime',
        message: event.status,
        extra: event.stats ? { stats: event.stats } : undefined,
      };
    }
    if (event.type === 'error') {
      return {
        type: 'error',
        ts: timestamp,
        source: 'system',
        message: event.message || event.error?.message,
      };
    }
    return {
      type: event.type || 'init',
      ts: timestamp,
      source: 'system',
      extra: event as Record<string, unknown>,
    };
  });
}

function extractGeminiFailure(commandResult: { stdout: string; stderr: string; exitCode: number }): string | undefined {
  const combined = `${commandResult.stdout}\n${commandResult.stderr}`.trim();
  if (!combined) return undefined;
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

export async function probeGeminiCli(): Promise<ProbeResult> {
  const probeHome = path.join(os.tmpdir(), 'kbench-gemini-probe-home');
  ensureGeminiHome(probeHome);
  const env = buildGeminiEnv(probeHome);
  const probeDir = path.join(os.tmpdir(), 'kbench-gemini-probe-files');
  fs.mkdirSync(probeDir, { recursive: true });
  const versionProbe = await runCliCommand({
    command: 'script',
    args: toScriptArgs(['gemini', '--version']),
    cwd: process.cwd(),
    env,
    stdoutPath: path.join(probeDir, 'version.stdout.txt'),
    stderrPath: path.join(probeDir, 'version.stderr.txt'),
    timeoutMs: 20_000,
  });
  const versionText = `${versionProbe.stdout}\n${versionProbe.stderr}`.trim();
  if (versionProbe.exitCode !== 0 && !versionText) {
    return {
      ok: false,
      command: 'gemini',
      errors: ['Failed to execute gemini --version.'],
    };
  }
  const help = await runCliCommand({
    command: 'script',
    args: toScriptArgs(['gemini', '--help']),
    cwd: process.cwd(),
    env,
    stdoutPath: path.join(probeDir, 'help.stdout.txt'),
    stderrPath: path.join(probeDir, 'help.stderr.txt'),
    timeoutMs: 20_000,
  });
  const helpText = `${help.stdout}\n${help.stderr}`.trim();
  const checks: ProbeCheck[] = [
    {
      id: 'prompt-mode',
      ok: helpText.includes('--prompt'),
      detail: helpText.includes('--prompt')
        ? 'gemini exposes --prompt non-interactive mode.'
        : 'gemini help does not expose --prompt.',
    },
    {
      id: 'output-format',
      ok: helpText.includes('--output-format'),
      detail: helpText.includes('--output-format')
        ? 'gemini exposes --output-format.'
        : 'gemini help does not expose --output-format.',
    },
    {
      id: 'stream-json',
      ok: helpText.includes('stream-json'),
      detail: helpText.includes('stream-json')
        ? 'gemini help advertises stream-json output support.'
        : 'gemini help does not advertise stream-json output support.',
    },
    {
      id: 'yolo-mode',
      ok: helpText.includes('--yolo'),
      detail: helpText.includes('--yolo')
        ? 'gemini exposes --yolo auto-approval mode.'
        : 'gemini help does not expose --yolo.',
    },
  ];

  const errors = [
    ...(help.exitCode === 0 ? [] : ['Failed to inspect gemini help output.']),
    ...checks.filter((check) => !check.ok).map((check) => check.detail),
  ].filter(Boolean);

  const versionLine = versionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => /^\d+\.\d+\.\d+/.test(line))
    || undefined;

  return {
    ok: help.exitCode === 0 && errors.length === 0,
    command: 'gemini',
    detectedVersion: versionLine,
    capabilities: geminiCliHarness.capabilities,
    checks,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export async function runGeminiCliTask(args: GeminiCliTaskArgs): Promise<GeminiCliTaskResult> {
  const artifactsDir = path.join(args.instanceDir, 'artifacts');
  const stdoutPath = path.join(artifactsDir, 'gemini-cli.stdout.txt');
  const stderrPath = path.join(artifactsDir, 'gemini-cli.stderr.txt');
  const patchBaseline = captureGitPatchBaseline(args.workDir);
  const configMode = resolveGeminiConfigMode(args.configMode);
  const geminiHome = configMode === 'isolated'
    ? path.join(artifactsDir, 'gemini-home')
    : getDefaultGeminiHome();

  ensureGeminiHome(geminiHome);
  const existingFiles = filterGeminiArtifactFiles(listFilesRecursively(path.join(geminiHome, '.gemini')));
  const env = applyProxyEnv(buildGeminiEnv(
    geminiHome,
    resolveGeminiApiKey(args.apiKeyEnv),
    resolveGeminiBaseUrl(args.baseUrl)
  ), {
    proxyUrl: args.proxyUrl,
    httpProxy: args.httpProxy,
    httpsProxy: args.httpsProxy,
    allProxy: args.allProxy,
    noProxy: args.noProxy,
  } satisfies ProxyConfig);

  const commandResult = await runCliCommand({
    command: 'script',
    args: toScriptArgs([
      'gemini',
      '--prompt',
      args.instruction,
      '--output-format',
      'stream-json',
      '--yolo',
      '--sandbox=false',
      '--model',
      args.modelName.split('/').slice(-1)[0],
    ]),
    cwd: args.workDir,
    env,
    stdoutPath,
    stderrPath,
    timeoutMs: args.timeoutMs,
  });

  const events = parseJsonLines(commandResult.stdout) as GeminiStreamEvent[];
  const finalText = extractTextFromGeminiEvents(events) || commandResult.stdout.trim() || undefined;
  const usage = extractUsageFromGeminiEvents(events);
  const currentFiles = filterGeminiArtifactFiles(listFilesRecursively(path.join(geminiHome, '.gemini')));
  const newFiles = currentFiles.filter((filePath) => !existingFiles.includes(filePath));
  const materializedSessionRoot = path.join(artifactsDir, 'gemini-session');
  const sessionFiles = configMode === 'isolated'
    ? currentFiles
    : await copyFilesPreservingRelativePaths(newFiles, path.join(geminiHome, '.gemini'), materializedSessionRoot);
  const patch = extractPatchSinceBaseline(patchBaseline);
  const { artifactManifestPath, traceFiles } = await materializeCliArtifacts({
    instanceDir: args.instanceDir,
    artifactsDir,
    stdoutPath,
    stderrPath,
    stdoutDescription: 'Raw stdout captured from gemini CLI.',
    stderrDescription: 'Raw stderr captured from gemini CLI.',
    patch,
    patchDescription: 'Patch returned by the workspace after gemini CLI execution.',
    sessionFiles: sessionFiles.map((sessionFile) => ({
      path: sessionFile,
      contentType: sessionFile.endsWith('.jsonl')
        ? 'application/x-ndjson'
        : sessionFile.endsWith('.json')
          ? 'application/json'
          : 'text/plain',
      description: 'Gemini CLI native session/history artifact.',
    })),
    normalizedTrace: events.length > 0 ? toTraceEvents(events) : undefined,
    nativeTraceFiles: events.length > 0
      ? [
          {
            sourcePath: stdoutPath,
            targetPath: 'gemini-stream.jsonl',
            contentType: 'application/x-ndjson',
            description: 'Gemini CLI stream-json event stream.',
          },
        ]
      : [],
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
    error: commandResult.exitCode === 0
      ? undefined
      : extractGeminiFailure(commandResult) || `gemini exited with code ${commandResult.exitCode}`,
  };
}
