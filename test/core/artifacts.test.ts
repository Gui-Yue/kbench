import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMaterializedTargetPath } from '../../src/core/artifacts.js';

describe('artifact path safety', () => {
  it('keeps normalized output paths under the target directory', () => {
    const target = resolveMaterializedTargetPath('/tmp/kbench-artifacts', 'adapter-files/logs/output.txt');

    expect(target).toBe(path.resolve('/tmp/kbench-artifacts', 'adapter-files/logs/output.txt'));
  });

  it('rejects relative paths that escape the target directory', () => {
    expect(() => resolveMaterializedTargetPath('/tmp/kbench-artifacts', '../outside.txt')).toThrow('Unsafe materialized output path');
    expect(() => resolveMaterializedTargetPath('/tmp/kbench-artifacts', '../../outside.txt')).toThrow('Unsafe materialized output path');
  });
});
