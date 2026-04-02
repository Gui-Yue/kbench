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
});
