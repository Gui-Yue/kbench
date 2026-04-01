import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '../..');
const cliEntryPath = path.join(repoRoot, 'src', 'cli', 'kbench.ts');

export interface KbenchCliResult {
  status: number | null | undefined;
  stdout: string;
  stderr: string;
}

let importCounter = 0;

async function waitForCliToSettle(importedAt: number, getLastActivityAt: () => number): Promise<void> {
  const startedAt = Date.now();
  let observedExitCodeAt: number | undefined;

  while (Date.now() - startedAt < 5_000) {
    const now = Date.now();
    const idleForMs = now - getLastActivityAt();
    const sawOutput = getLastActivityAt() > importedAt;

    if (process.exitCode !== undefined) {
      observedExitCodeAt ??= now;
      if (idleForMs >= 25 && now - observedExitCodeAt >= 25) {
        return;
      }
    } else if (sawOutput && idleForMs >= 25) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function normalizeChunk(chunk: unknown, encoding?: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf-8');
  }
  return String(chunk ?? '');
}

export async function runKbench(args: string[]): Promise<KbenchCliResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const previousArgv = [...process.argv];
  const previousExitCode = process.exitCode;
  const previousRepoRoot = process.env.KBENCH_REPO_ROOT;
  let lastActivityAt = Date.now();

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    stdoutChunks.push(normalizeChunk(chunk, encoding));
    lastActivityAt = Date.now();
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof cb === 'function') {
      cb();
    }
    return true;
  }) as typeof process.stdout.write);

  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    stderrChunks.push(normalizeChunk(chunk, encoding));
    lastActivityAt = Date.now();
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof cb === 'function') {
      cb();
    }
    return true;
  }) as typeof process.stderr.write);
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrChunks.push(`${args.map((arg) => String(arg)).join(' ')}\n`);
    lastActivityAt = Date.now();
  });

  try {
    process.argv = ['node', cliEntryPath, ...args];
    process.exitCode = undefined;
    process.env.KBENCH_REPO_ROOT = repoRoot;

    const entryUrl = pathToFileURL(cliEntryPath);
    entryUrl.searchParams.set('kbench-test', String(importCounter += 1));
    const importedAt = Date.now();
    await import(entryUrl.href);
    await waitForCliToSettle(importedAt, () => lastActivityAt);

    return {
      status: process.exitCode ?? 0,
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    if (previousRepoRoot === undefined) {
      delete process.env.KBENCH_REPO_ROOT;
    } else {
      process.env.KBENCH_REPO_ROOT = previousRepoRoot;
    }
  }
}
