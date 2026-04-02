import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ProxyConfig {
  proxyUrl?: string;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
}

export interface CliProbeResult {
  ok: boolean;
  command: string;
  detectedVersion?: string;
  errors?: string[];
  warnings?: string[];
}

export interface CliInspectResult {
  ok: boolean;
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  error?: string;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface CliExecutionOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}

export async function probeCliCommand(command: string, args: string[] = ['--version'], env?: NodeJS.ProcessEnv): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    execFile(command, args, { env }, (error, stdout, stderr) => {
      if (error) {
        const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${command} not found in PATH`
          : error.message;
        resolve({
          ok: false,
          command,
          errors: [message, stderr.trim()].filter(Boolean),
        });
        return;
      }

      const text = `${stdout}\n${stderr}`.trim();
      const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve({
        ok: true,
        command,
        detectedVersion: firstLine,
      });
    });
  });
}

export async function inspectCliCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliInspectResult> {
  return new Promise((resolve) => {
    execFile(command, args, { env }, (error, stdout, stderr) => {
      const combined = `${stdout}\n${stderr}`.trim();
      if (error) {
        const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `${command} not found in PATH`
          : error.message;
        resolve({
          ok: false,
          command,
          args,
          exitCode: typeof (error as any)?.code === 'number' ? (error as any).code : 1,
          stdout,
          stderr,
          combined,
          error: [message, stderr.trim()].filter(Boolean).join('\n'),
        });
        return;
      }

      resolve({
        ok: true,
        command,
        args,
        exitCode: 0,
        stdout,
        stderr,
        combined,
      });
    });
  });
}

export function includesAll(text: string, patterns: string[]): boolean {
  const haystack = text.toLowerCase();
  return patterns.every((pattern) => haystack.includes(pattern.toLowerCase()));
}

export function applyProxyEnv(env: NodeJS.ProcessEnv, proxy: ProxyConfig): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  const defaultProxy = proxy.proxyUrl;
  const httpProxy = proxy.httpProxy || defaultProxy;
  const httpsProxy = proxy.httpsProxy || defaultProxy;
  const allProxy = proxy.allProxy || defaultProxy;

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
  if (proxy.noProxy) {
    nextEnv.NO_PROXY = proxy.noProxy;
    nextEnv.no_proxy = proxy.noProxy;
  }

  return nextEnv;
}

export async function runCliCommand(options: CliExecutionOptions): Promise<CliRunResult> {
  fs.mkdirSync(path.dirname(options.stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(options.stderrPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }, options.timeoutMs);
    }

    let stdout = '';
    let stderr = '';

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', async (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      try {
        await fs.promises.writeFile(options.stdoutPath, stdoutChunks.join(''), 'utf-8');
        await fs.promises.writeFile(options.stderrPath, stderrChunks.join(''), 'utf-8');
      } catch (error) {
        reject(error);
        return;
      }

      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}\nProcess timed out after ${options.timeoutMs}ms.`.trim() : stderr,
        stdoutPath: options.stdoutPath,
        stderrPath: options.stderrPath,
      });
    });
  });
}

export function parseJsonLines(text: string): any[] {
  const events: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return events;
}

export function listJsonlFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const found: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return found.sort();
}
