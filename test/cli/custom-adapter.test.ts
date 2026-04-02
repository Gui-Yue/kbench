import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runKbench } from '../helpers/cli.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbench-custom-adapter-test-'));
  tempDirs.push(dir);
  return dir;
}

async function createDualModeAdapter(root: string): Promise<string> {
  const adapterDir = path.join(root, 'adapter');
  await fs.mkdir(adapterDir, { recursive: true });

  await fs.writeFile(
    path.join(adapterDir, 'adapter.manifest.json'),
    `${JSON.stringify({
      schemaVersion: 'kbench.adapter/v1',
      id: 'dual-mode-adapter',
      kind: 'node',
      entry: './runner.mjs',
      version: '0.1.0',
      supportedBenchmarks: ['swe', 'tau'],
      capabilities: {
        runModes: ['task', 'session'],
        machineReadableStdout: true,
        supportsPatchOutput: true,
        supportsTrajectory: true,
        supportsToolCallTrace: true,
        supportsResume: false,
        supportsImages: false,
        supportsSandboxBridge: false,
        supportsPromptTemplate: false,
      },
    }, null, 2)}\n`,
    'utf-8'
  );

  const runnerSource = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const input = process.env.KBENCH_ADAPTER_INPUT
  ? readFileSync(process.env.KBENCH_ADAPTER_INPUT, 'utf8')
  : readFileSync(0, 'utf8');
const payload = JSON.parse(input || '{}');

writeFileSync('./artifact.txt', payload.mode === 'session' ? 'session artifact' : 'task artifact', 'utf8');
writeFileSync('./trace.log', payload.mode === 'session' ? 'session trace' : 'task trace', 'utf8');

const output = payload.mode === 'session'
  ? {
      ok: true,
      status: 'ok',
      action: 'respond(done)',
      finalText: 'session adapter response',
      elapsedMs: 2,
      artifacts: [{ kind: 'log', path: './artifact.txt', contentType: 'text/plain', description: 'adapter artifact' }],
      trace: {
        normalized: [{ type: 'result', ts: new Date().toISOString(), source: 'runtime', message: 'session complete' }],
        native: [{ kind: 'native', path: './trace.log', contentType: 'text/plain', description: 'native trace' }],
      },
      benchmarkResult: { mode: 'session-test' },
    }
  : {
      ok: true,
      status: 'ok',
      finalText: 'task adapter response',
      patch: 'diff --git a/a.txt b/a.txt\\n',
      elapsedMs: 2,
      artifacts: [{ kind: 'log', path: './artifact.txt', contentType: 'text/plain', description: 'adapter artifact' }],
      trace: {
        normalized: [{ type: 'message', ts: new Date().toISOString(), source: 'agent', message: 'task complete' }],
        native: [{ kind: 'native', path: './trace.log', contentType: 'text/plain', description: 'native trace' }],
      },
      benchmarkResult: { mode: 'task-test' },
    };

process.stdout.write(JSON.stringify(output));
`;

  await fs.writeFile(path.join(adapterDir, 'runner.mjs'), runnerSource, { encoding: 'utf-8', mode: 0o755 });
  return adapterDir;
}

async function createTraversalAdapter(root: string): Promise<string> {
  const adapterDir = path.join(root, 'nested', 'adapter');
  await fs.mkdir(adapterDir, { recursive: true });

  await fs.writeFile(
    path.join(adapterDir, 'adapter.manifest.json'),
    `${JSON.stringify({
      schemaVersion: 'kbench.adapter/v1',
      id: 'traversal-adapter',
      kind: 'node',
      entry: './runner.mjs',
      version: '0.1.0',
      supportedBenchmarks: ['swe'],
      capabilities: {
        runModes: ['task'],
        machineReadableStdout: true,
        supportsPatchOutput: false,
        supportsTrajectory: true,
        supportsToolCallTrace: true,
        supportsResume: false,
        supportsImages: false,
        supportsSandboxBridge: false,
        supportsPromptTemplate: false,
      },
    }, null, 2)}\n`,
    'utf-8'
  );

  const runnerSource = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

writeFileSync('../../outside.txt', 'adapter artifact outside source', 'utf8');
writeFileSync('../../outside-trace.log', 'adapter trace outside source', 'utf8');

process.stdout.write(JSON.stringify({
  ok: true,
  status: 'ok',
  finalText: 'done',
  elapsedMs: 1,
  artifacts: [{ kind: 'log', path: '../../outside.txt', contentType: 'text/plain' }],
  trace: {
    native: [{ kind: 'native', path: '../../outside-trace.log', contentType: 'text/plain' }],
  },
}));
`;

  await fs.writeFile(path.join(adapterDir, 'runner.mjs'), runnerSource, { encoding: 'utf-8', mode: 0o755 });
  return adapterDir;
}

describe('custom adapter runtime', () => {
  it('runs a task-mode custom adapter and materializes adapter outputs', async () => {
    const root = await makeTempRoot();
    const adapterDir = await createDualModeAdapter(root);
    const runDir = path.join(root, 'task-run');

    const result = await runKbench([
      'run',
      '--benchmark',
      'swe',
      '--harness',
      'custom-adapter',
      '--adapter',
      adapterDir,
      '--model-name',
      'openai/gpt-4.1-mini',
      '--instruction',
      'Fix the bug',
      '--run-dir',
      runDir,
      '--instance-id',
      'custom-task',
    ]);

    expect(result.status).toBe(0);

    const persisted = JSON.parse(await fs.readFile(path.join(runDir, 'instances', 'custom-task', 'result.json'), 'utf-8'));
    expect(persisted.ok).toBe(true);
    expect(persisted.status).toBe('ok');
    expect(persisted.finalText).toBe('task adapter response');
    expect(persisted.patch).toContain('diff --git');
    expect(persisted.trace).toHaveLength(2);
    expect(persisted.artifacts.some((artifact: { kind: string }) => artifact.kind === 'patch')).toBe(true);
    expect(await fs.readFile(path.join(runDir, 'instances', 'custom-task', 'artifacts', 'adapter-files', 'artifact.txt'), 'utf-8')).toBe('task artifact');
  });

  it('runs a session-mode custom adapter for tau', async () => {
    const root = await makeTempRoot();
    const adapterDir = await createDualModeAdapter(root);
    const runDir = path.join(root, 'session-run');
    const messagesFile = path.join(root, 'messages.json');
    const toolsFile = path.join(root, 'tools.json');

    await fs.writeFile(messagesFile, `${JSON.stringify([{ role: 'user', content: 'hello' }], null, 2)}\n`, 'utf-8');
    await fs.writeFile(
      toolsFile,
      `${JSON.stringify([{ name: 'lookup', description: 'lookup tool', input_schema: { type: 'object', properties: {} } }], null, 2)}\n`,
      'utf-8'
    );

    const result = await runKbench([
      'run',
      '--benchmark',
      'tau',
      '--harness',
      'custom-adapter',
      '--adapter',
      adapterDir,
      '--model-name',
      'openai/gpt-4.1-mini',
      '--messages-file',
      messagesFile,
      '--tools-file',
      toolsFile,
      '--run-dir',
      runDir,
      '--instance-id',
      'custom-session',
    ]);

    expect(result.status).toBe(0);

    const persisted = JSON.parse(await fs.readFile(path.join(runDir, 'instances', 'custom-session', 'result.json'), 'utf-8'));
    expect(persisted.ok).toBe(true);
    expect(persisted.status).toBe('ok');
    expect(persisted.action).toBe('respond(done)');
    expect(persisted.finalText).toBe('session adapter response');
    expect(persisted.benchmarkResult.mode).toBe('session-test');
    expect(await fs.readFile(path.join(runDir, 'instances', 'custom-session', 'artifacts', 'adapter-files', 'artifact.txt'), 'utf-8')).toBe('session artifact');
  });

  it('persists a failed run result when the adapter runtime throws before producing output', async () => {
    const root = await makeTempRoot();
    const runDir = path.join(root, 'failed-run');

    const result = await runKbench([
      'run',
      '--benchmark',
      'swe',
      '--harness',
      'custom-adapter',
      '--adapter',
      path.join(root, 'missing-adapter'),
      '--model-name',
      'openai/gpt-4.1-mini',
      '--instruction',
      'Fix the bug',
      '--run-dir',
      runDir,
      '--instance-id',
      'failed-custom-task',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Adapter path does not exist');

    const persisted = JSON.parse(await fs.readFile(path.join(runDir, 'instances', 'failed-custom-task', 'result.json'), 'utf-8'));
    const summary = JSON.parse(await fs.readFile(path.join(runDir, 'summary.json'), 'utf-8'));

    expect(persisted.ok).toBe(false);
    expect(persisted.status).toBe('invalid_adapter');
    expect(summary.total).toBe(1);
    expect(summary.errored).toBe(1);
    expect(summary.byStatus.invalid_adapter).toBe(1);
  });

  it('sanitizes adapter artifact and trace output paths before materializing files', async () => {
    const root = await makeTempRoot();
    const adapterDir = await createTraversalAdapter(root);
    const runDir = path.join(root, 'traversal-run');

    const result = await runKbench([
      'run',
      '--benchmark',
      'swe',
      '--harness',
      'custom-adapter',
      '--adapter',
      adapterDir,
      '--model-name',
      'openai/gpt-4.1-mini',
      '--instruction',
      'Fix the bug',
      '--run-dir',
      runDir,
      '--instance-id',
      'traversal-task',
    ]);

    expect(result.status).toBe(0);
    expect(await fs.readFile(path.join(runDir, 'instances', 'traversal-task', 'artifacts', 'adapter-files', 'outside.txt'), 'utf-8')).toBe('adapter artifact outside source');
    expect(await fs.readFile(path.join(runDir, 'instances', 'traversal-task', 'trace', 'native', 'outside-trace.log'), 'utf-8')).toBe('adapter trace outside source');
    await expect(fs.access(path.join(runDir, 'instances', 'traversal-task', 'outside.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'instances', 'traversal-task', 'trace', 'outside-trace.log'))).rejects.toThrow();
  });
});
