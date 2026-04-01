import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ProbeCheck, ProbeResult } from '../../types.js';
import { codexHarness } from './manifest.js';
import { probeCliCommand, inspectCliCommand, runCliCommand, parseJsonLines, listJsonlFiles, applyProxyEnv, type ProxyConfig } from '../cli/shared.js';
import { captureGitPatchBaseline, copyFilesPreservingRelativePaths, extractPatchSinceBaseline, materializeCliArtifacts } from '../cli/runtime.js';

export interface CodexTaskArgs {
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

export interface CodexTaskResult {
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

export async function probeCodex(): Promise<ProbeResult> {
  const versionProbe = await probeCliCommand('codex');
  if (!versionProbe.ok) {
    return {
      ok: false,
      command: 'codex',
      errors: versionProbe.errors,
      warnings: versionProbe.warnings,
    };
  }

  const execHelp = await inspectCliCommand('codex', ['exec', '--help']);
  const helpText = execHelp.combined;
  const checks: ProbeCheck[] = [
    {
      id: 'exec-subcommand',
      ok: execHelp.ok,
      detail: execHelp.ok ? 'codex exec --help is available.' : (execHelp.error || 'Failed to inspect codex exec help.'),
    },
    {
      id: 'json-output',
      ok: helpText.includes('--json'),
      detail: helpText.includes('--json')
        ? 'codex exec exposes --json JSONL output.'
        : 'codex exec help does not expose --json.',
    },
    {
      id: 'sandbox-bypass',
      ok: helpText.includes('--dangerously-bypass-approvals-and-sandbox'),
      detail: helpText.includes('--dangerously-bypass-approvals-and-sandbox')
        ? 'codex exec exposes the sandbox bypass flag required by the current runner.'
        : 'codex exec help does not expose --dangerously-bypass-approvals-and-sandbox.',
    },
  ];

  const errors = checks.filter((check) => !check.ok).map((check) => check.detail);
  return {
    ok: errors.length === 0,
    command: 'codex',
    detectedVersion: versionProbe.detectedVersion,
    capabilities: codexHarness.capabilities,
    checks,
    errors: errors.length > 0 ? errors : undefined,
    warnings: versionProbe.warnings,
  };
}

function getDefaultCodexHome(): string {
  const configured = process.env.CODEX_HOME;
  if (configured && configured.trim()) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.codex');
}

function resolveCodexConfigMode(mode?: 'inherit' | 'isolated'): 'inherit' | 'isolated' {
  return mode === 'isolated' ? 'isolated' : 'inherit';
}

function resolveCodexApiKey(apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv) {
    return process.env[apiKeyEnv];
  }
  return process.env.OPENAI_API_KEY;
}

function resolveCodexBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl || process.env.OPENAI_BASE_URL;
}

function extractTextFromCodexEvents(events: any[]): string | undefined {
  const agentMessages: string[] = [];
  const messages: string[] = [];

  for (const event of events) {
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message' && typeof event?.item?.text === 'string') {
      const text = event.item.text.trim();
      if (text) {
        agentMessages.push(text);
      }
      continue;
    }

    if (event?.type !== 'response_item') continue;
    const payload = event?.payload;
    if (!payload || payload.type !== 'message' || payload.role !== 'assistant') continue;
    const content: Array<{ text?: string }> = Array.isArray(payload.content) ? payload.content : [];
    const text = content
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('')
      .trim();
    if (text) {
      messages.push(text);
    }
  }

  if (agentMessages.length > 0) {
    return agentMessages[agentMessages.length - 1];
  }
  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

function extractUsageFromCodexEvents(events: any[]): CodexTaskResult['usage'] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'turn.completed' || typeof event?.usage !== 'object' || !event.usage) {
      continue;
    }
    return {
      input_tokens: typeof event.usage.input_tokens === 'number' ? event.usage.input_tokens : undefined,
      cached_input_tokens: typeof event.usage.cached_input_tokens === 'number' ? event.usage.cached_input_tokens : undefined,
      output_tokens: typeof event.usage.output_tokens === 'number' ? event.usage.output_tokens : undefined,
    };
  }
  return undefined;
}

export async function runCodexTask(args: CodexTaskArgs): Promise<CodexTaskResult> {
  const artifactsDir = path.join(args.instanceDir, 'artifacts');
  const stdoutPath = path.join(artifactsDir, 'codex.stdout.txt');
  const stderrPath = path.join(artifactsDir, 'codex.stderr.txt');
  const patchBaseline = captureGitPatchBaseline(args.workDir);
  const codexHomeMode = resolveCodexConfigMode(args.configMode);
  const codexHome = codexHomeMode === 'isolated'
    ? path.join(artifactsDir, 'codex-home')
    : getDefaultCodexHome();
  const sessionRoot = path.join(codexHome, 'sessions');
  const existingSessionFiles = listJsonlFiles(sessionRoot);

  if (codexHomeMode === 'isolated') {
    fs.mkdirSync(codexHome, { recursive: true });
  }

  const openaiApiKey = resolveCodexApiKey(args.apiKeyEnv);
  if (openaiApiKey && codexHomeMode === 'isolated') {
    await fs.promises.writeFile(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: openaiApiKey }, null, 2),
      'utf-8'
    );
  }

  let env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
  };
  if (openaiApiKey) {
    env.OPENAI_API_KEY = openaiApiKey;
  }
  const openaiBaseUrl = resolveCodexBaseUrl(args.baseUrl);
  if (openaiBaseUrl) {
    env.OPENAI_BASE_URL = openaiBaseUrl;
  }
  env = applyProxyEnv(env, {
    proxyUrl: args.proxyUrl,
    httpProxy: args.httpProxy,
    httpsProxy: args.httpsProxy,
    allProxy: args.allProxy,
    noProxy: args.noProxy,
  } satisfies ProxyConfig);

  const commandResult = await runCliCommand({
    command: 'codex',
    args: [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--model',
      args.modelName.split('/').slice(-1)[0],
      '--json',
      '--enable',
      'unified_exec',
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
  const finalText = extractTextFromCodexEvents(events) || commandResult.stdout.trim() || undefined;
  const usage = extractUsageFromCodexEvents(events);
  const currentSessionFiles = listJsonlFiles(sessionRoot);
  const newSessionFiles = currentSessionFiles.filter((sessionFile) => !existingSessionFiles.includes(sessionFile));
  const materializedSessionRoot = path.join(artifactsDir, 'codex-sessions');
  const sessionFiles = codexHomeMode === 'isolated'
    ? currentSessionFiles
    : await copyFilesPreservingRelativePaths(newSessionFiles, sessionRoot, materializedSessionRoot);
  const patch = extractPatchSinceBaseline(patchBaseline);
  const { artifactManifestPath, traceFiles } = await materializeCliArtifacts({
    instanceDir: args.instanceDir,
    artifactsDir,
    stdoutPath,
    stderrPath,
    stdoutDescription: 'Raw stdout captured from codex exec.',
    stderrDescription: 'Raw stderr captured from codex exec.',
    patch,
    patchDescription: 'Git diff captured after codex execution.',
    sessionFiles: sessionFiles.map((sessionFile) => ({
      path: sessionFile,
      contentType: 'application/x-ndjson',
      description: 'Codex native session JSONL export.',
    })),
    nativeTraceFiles: [
      {
        sourcePath: stdoutPath,
        targetPath: 'codex-exec.jsonl',
        contentType: 'application/x-ndjson',
        description: 'Codex exec JSONL event stream.',
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
    error: commandResult.exitCode === 0 ? undefined : (commandResult.stderr.trim() || commandResult.stdout.trim() || 'codex exec failed'),
  };
}
