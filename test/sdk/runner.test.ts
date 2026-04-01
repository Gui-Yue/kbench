import { describe, expect, it } from 'vitest';

import { parseRunnerOutput, resolveRunnerCommand } from '../../src/harness/sdk/runner.js';

describe('adapter runner helpers', () => {
  it('resolves execution commands by adapter kind', () => {
    expect(resolveRunnerCommand('cli', '/tmp/runner.sh')).toEqual(['/tmp/runner.sh']);
    expect(resolveRunnerCommand('python', '/tmp/runner.py')).toEqual(['python3', '/tmp/runner.py']);
    expect(resolveRunnerCommand('node', '/tmp/runner.mjs')).toEqual(['node', '/tmp/runner.mjs']);
  });

  it('parses the last non-empty stdout line as runner output', () => {
    const parsed = parseRunnerOutput([
      'log line before json',
      '',
      '{"ok":true,"status":"ok","elapsedMs":3,"finalText":"done"}',
      '',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('ok');
    expect(parsed.elapsedMs).toBe(3);
    expect(parsed.finalText).toBe('done');
  });

  it('throws when the runner stdout does not end with JSON', () => {
    expect(() => parseRunnerOutput('not json at all')).toThrow();
  });
});
