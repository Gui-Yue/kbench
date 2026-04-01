import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAdapter } from '../../src/harness/sdk/generate.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbench-generate-vitest-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('adapter generator', () => {
  it('bootstraps a CLI adapter from a local package with bin signals', async () => {
    const root = await makeTempRoot();
    const repoDir = path.join(root, 'sample-cli-repo');
    const outDir = path.join(root, 'generated-cli-adapter');

    await writeJson(path.join(repoDir, 'package.json'), {
      name: 'sample-cli-repo',
      version: '0.0.1',
      bin: {
        'sample-cli': './bin/sample-cli.js',
      },
      scripts: {
        start: 'node ./bin/sample-cli.js',
      },
    });
    await fs.mkdir(path.join(repoDir, 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'bin', 'sample-cli.js'),
      '#!/usr/bin/env node\nconsole.log("hello from sample cli");\n',
      'utf-8'
    );
    await fs.writeFile(
      path.join(repoDir, 'README.md'),
      'A command line harness with --help and --output-format support.\n',
      'utf-8'
    );

    const result = await generateAdapter({
      repo: repoDir,
      outDir,
    });

    expect(result.report.sourceType).toBe('local');
    expect(result.report.harnessHint).toBe('cli-harness');
    expect(result.report.inferredType).toBe('cli');
    expect(result.report.runModes).toEqual(['task']);
    expect(result.report.supportedBenchmarks).toEqual(['swe', 'tb2']);
    expect(result.report.candidateCommands).toContain('sample-cli');
    expect(result.report.candidateCommands).toContain(result.report.recommendedCommand);
    expect(result.validation?.ok).toBe(true);
    expect(result.files.map((filePath) => path.basename(filePath))).toContain('adapter.generate.json');
    expect(result.files.map((filePath) => path.basename(filePath))).toContain('adapter.validate.json');
  });

  it('uses the langchain hint to generate a dual-mode python adapter', async () => {
    const root = await makeTempRoot();
    const repoDir = path.join(root, 'langchain-agent');
    const outDir = path.join(root, 'generated-langchain-adapter');

    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'README.md'),
      'LangChain runner with task mode and session mode support for tau benchmarks.\n',
      'utf-8'
    );
    await fs.writeFile(
      path.join(repoDir, 'agent_runner.py'),
      'def main():\n    print("runner")\n',
      'utf-8'
    );

    const result = await generateAdapter({
      repo: repoDir,
      outDir,
      hint: 'langchain-runner',
    });

    expect(result.report.harnessHint).toBe('langchain-runner');
    expect(result.report.inferredType).toBe('python');
    expect(result.report.runModes).toEqual(['task', 'session']);
    expect(result.report.supportedBenchmarks).toEqual(['swe', 'tb2', 'tau']);
    expect(result.report.candidateCommands).toContain('python3 agent_runner.py');
    expect(result.validation?.ok).toBe(true);
  });

  it('keeps remote identifiers heuristic-only and surfaces a warning', async () => {
    const root = await makeTempRoot();
    const outDir = path.join(root, 'generated-remote-adapter');

    const result = await generateAdapter({
      repo: 'https://github.com/example/unknown-agent',
      outDir,
      hint: 'cli-harness',
      validate: false,
    });

    expect(result.report.sourceType).toBe('remote-url');
    expect(result.report.warnings).toContain(
      'Remote repo URLs are not fetched automatically. This generator used only the provided identifier/URL text.'
    );
    expect(result.validation).toBeUndefined();
  });
});
