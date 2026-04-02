import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureGitPatchBaseline, extractPatchSinceBaseline } from '../../src/harness/drivers/cli/runtime.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbench-cli-runtime-'));
  tempDirs.push(dir);

  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'kbench@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'kbench'], { cwd: dir, stdio: 'ignore' });

  await fs.writeFile(path.join(dir, 'tracked.txt'), 'base\n', 'utf-8');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

  return dir;
}

describe('CLI runtime patch capture', () => {
  it('captures the current diff even when the worktree was already dirty before execution', async () => {
    const repoDir = await makeGitRepo();

    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'base\nbefore\n', 'utf-8');
    const baseline = captureGitPatchBaseline(repoDir);

    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'base\nbefore\nafter\n', 'utf-8');
    const patch = extractPatchSinceBaseline(baseline);

    expect(patch).toBeDefined();
    expect(patch).toContain('tracked.txt');
    expect(patch).toContain('after');
  });
});
