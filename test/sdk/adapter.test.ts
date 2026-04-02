import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initAdapter } from '../../src/harness/sdk/init.js';
import { validateAdapter } from '../../src/harness/sdk/validate.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbench-vitest-'));
  tempDirs.push(dir);
  return dir;
}

describe('adapter scaffolding', () => {
  it('creates a node adapter scaffold with the expected files', async () => {
    const root = await makeTempRoot();
    const adapterDir = path.join(root, 'sample-adapter');

    const result = await initAdapter({
      type: 'node',
      name: 'sample-adapter',
      outDir: adapterDir,
    });

    expect(result.adapterDir).toBe(adapterDir);
    expect(result.files.map((filePath) => path.basename(filePath))).toEqual([
      'adapter.manifest.json',
      'runner.mjs',
      'README.md',
    ]);
  });

  it('validates the generated node adapter end-to-end', async () => {
    const root = await makeTempRoot();
    const adapterDir = path.join(root, 'sample-adapter');

    await initAdapter({
      type: 'node',
      name: 'sample-adapter',
      outDir: adapterDir,
    });

    const report = await validateAdapter(adapterDir);

    expect(report.ok).toBe(true);
    expect(report.manifestValidation.ok).toBe(true);
    expect(report.entryValidation.ok).toBe(true);
    expect(report.executionChecks).toHaveLength(1);
    expect(report.executionChecks[0]?.ok).toBe(true);
    expect(report.executionChecks[0]?.mode).toBe('task');
    expect(report.executionChecks[0]?.output?.status).toBe('ok');
  });

  it('does not mark adapter validation as ok when execution has both errors and warnings', async () => {
    const root = await makeTempRoot();
    const adapterDir = path.join(root, 'warning-error-adapter');

    await fs.mkdir(adapterDir, { recursive: true });
    await fs.writeFile(
      path.join(adapterDir, 'adapter.manifest.json'),
      `${JSON.stringify({
        schemaVersion: 'kbench.adapter/v1',
        id: 'warning-error-adapter',
        kind: 'node',
        entry: './runner.mjs',
        version: '0.1.0',
        supportedBenchmarks: ['swe'],
        capabilities: {
          runModes: ['task'],
          machineReadableStdout: true,
          supportsPatchOutput: false,
          supportsTrajectory: false,
          supportsToolCallTrace: false,
          supportsResume: false,
          supportsImages: false,
          supportsSandboxBridge: false,
          supportsPromptTemplate: false,
        },
      }, null, 2)}\n`,
      'utf-8'
    );
    await fs.writeFile(
      path.join(adapterDir, 'runner.mjs'),
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  ok: true,
  status: 'bad-status',
  elapsedMs: 1,
  patch: 'diff --git a/a b/a\\n',
}));
`,
      { encoding: 'utf-8', mode: 0o755 }
    );

    const report = await validateAdapter(adapterDir);

    expect(report.ok).toBe(false);
    expect(report.executionChecks).toHaveLength(1);
    expect(report.executionChecks[0]?.ok).toBe(false);
    expect(report.executionChecks[0]?.errors.some((error) => error.includes('valid "status"'))).toBe(true);
    expect(report.executionChecks[0]?.warnings.some((warning) => warning.includes('returned a patch'))).toBe(true);
  });
});
