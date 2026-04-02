import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ADAPTER_INPUT_PATH_ENV, type AdapterRunnerInput, type AdapterRunnerOutput } from './protocol.js';
import type { AdapterKind, AdapterManifest } from './manifest.js';

export interface AdapterRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: AdapterRunnerOutput;
  error?: string;
}

export function resolveRunnerCommand(kind: AdapterKind, entryPath: string): string[] {
  if (kind === 'cli') return [entryPath];
  if (kind === 'python') return ['python3', entryPath];
  return ['node', entryPath];
}

export function parseRunnerOutput(stdout: string): AdapterRunnerOutput {
  const trimmed = stdout.trim();
  const candidates = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const payloadText = candidates.length > 0 ? candidates[candidates.length - 1] : trimmed;
  return JSON.parse(payloadText);
}

function applyProxyEnv(env: NodeJS.ProcessEnv, input: AdapterRunnerInput): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  const defaultProxy = input.config.proxyUrl;
  const httpProxy = input.config.httpProxy || defaultProxy;
  const httpsProxy = input.config.httpsProxy || defaultProxy;
  const allProxy = input.config.allProxy || defaultProxy;

  if (httpProxy) {
    nextEnv.HTTP_PROXY = httpProxy;
    nextEnv.http_proxy = httpProxy;
  }
  if (httpsProxy) {
    nextEnv.HTTPS_PROXY = httpsProxy;
    nextEnv.https_proxy = httpsProxy;
  }
  if (allProxy) {
    nextEnv.ALL_PROXY = allProxy;
    nextEnv.all_proxy = allProxy;
  }
  if (input.config.noProxy) {
    nextEnv.NO_PROXY = input.config.noProxy;
    nextEnv.no_proxy = input.config.noProxy;
  }

  return nextEnv;
}

async function executeProcess(
  command: string[],
  cwd: string,
  inputPath: string,
  serializedInput: string,
  input: AdapterRunnerInput
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: applyProxyEnv({
        ...process.env,
        [ADAPTER_INPUT_PATH_ENV]: inputPath,
      }, input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        error: error.message,
      });
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        error: code === 0 ? undefined : `Runner exited with code ${code ?? 1}.`,
      });
    });

    child.stdin.write(serializedInput);
    child.stdin.end();
  });
}

async function executeWithPythonFallback(
  command: string[],
  cwd: string,
  inputPath: string,
  input: AdapterRunnerInput
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  const [bin, ...args] = command;
  const trampoline = [
    '-c',
    [
      'import json, os, subprocess, sys',
      'cwd = sys.argv[1]',
      'input_path = sys.argv[2]',
      'cmd = sys.argv[3:]',
      'env = os.environ.copy()',
      `env["${ADAPTER_INPUT_PATH_ENV}"] = input_path`,
      'proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)',
      'sys.stdout.write(json.dumps({"exitCode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}))',
    ].join('; '),
    cwd,
    inputPath,
    bin,
    ...args,
  ];

  return new Promise((resolve) => {
    const child = spawn('python3', trampoline, {
      env: applyProxyEnv(process.env, input),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on('close', () => {
      if (stderr.trim()) {
        resolve({
          exitCode: 1,
          stdout,
          stderr,
          error: stderr.trim(),
        });
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        resolve({
          exitCode: payload.exitCode,
          stdout: payload.stdout || '',
          stderr: payload.stderr || '',
          error: payload.exitCode === 0 ? undefined : `Runner exited with code ${payload.exitCode}.`,
        });
      } catch (error: any) {
        resolve({
          exitCode: 1,
          stdout,
          stderr,
          error: `Failed to parse python trampoline output: ${error?.message || error}`,
        });
      }
    });
  });
}

export async function executeAdapterRunner(
  manifest: AdapterManifest,
  entryPath: string,
  input: AdapterRunnerInput,
  cwd: string
): Promise<AdapterRunResult> {
  const command = resolveRunnerCommand(manifest.kind, entryPath);

  const serializedInput = JSON.stringify(input);
  const inputPath = path.join(
    os.tmpdir(),
    `kbench-adapter-input-${manifest.id}-${input.mode}-${Date.now()}.json`
  );
  await fs.promises.writeFile(inputPath, serializedInput, 'utf-8');

  let result = await executeProcess(command, cwd, inputPath, serializedInput, input);
  if (
    manifest.kind === 'node'
    && result.exitCode === 0
    && !result.stdout.trim()
    && !result.stderr.trim()
  ) {
    result = await executeWithPythonFallback(command, cwd, inputPath, input);
  }
  await fs.promises.unlink(inputPath).catch(() => undefined);

  if (result.error && result.exitCode !== 0) {
    return result;
  }

  try {
    return {
      ...result,
      output: parseRunnerOutput(result.stdout),
    };
  } catch (error: any) {
    return {
      ...result,
      error: `Runner stdout is not valid JSON output: ${error?.message || error}`,
    };
  }
}
