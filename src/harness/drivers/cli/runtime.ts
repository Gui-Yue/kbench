import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { writeArtifactManifest, type ArtifactManifestEntry } from '../../../core/artifacts.js';
import type { TraceRef } from '../../../core/results.js';
import { materializeNativeTraceFile, writeNormalizedTrace, type TraceEvent } from '../../../core/traces.js';

export interface CliSessionArtifact {
  path: string;
  contentType: string;
  description: string;
}

export interface CliNativeTraceSource {
  sourcePath: string;
  targetPath: string;
  contentType?: string;
  description?: string;
}

export interface MaterializeCliArtifactsArgs {
  instanceDir: string;
  artifactsDir: string;
  stdoutPath: string;
  stderrPath: string;
  stdoutDescription: string;
  stderrDescription: string;
  patch?: string;
  patchDescription: string;
  sessionFiles?: CliSessionArtifact[];
  normalizedTrace?: TraceEvent[];
  nativeTraceFiles?: CliNativeTraceSource[];
}

export interface MaterializeCliArtifactsResult {
  artifactManifestPath: string;
  traceFiles: TraceRef[];
}

export interface GitPatchBaseline {
  workDir: string;
  supported: boolean;
  beforeDiff?: string;
}

export async function copyFilesPreservingRelativePaths(
  files: string[],
  sourceRoot: string,
  targetRoot: string
): Promise<string[]> {
  const copied: string[] = [];
  for (const sourcePath of files) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    const targetPath = path.join(targetRoot, relativePath);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);
    copied.push(targetPath);
  }
  return copied;
}

function readGitDiff(workDir: string): string | undefined {
  try {
    const output = execFileSync('git', ['diff'], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output;
  } catch {
    return undefined;
  }
}

export function captureGitPatchBaseline(workDir: string): GitPatchBaseline {
  const beforeDiff = readGitDiff(workDir);
  return {
    workDir,
    supported: beforeDiff !== undefined,
    beforeDiff,
  };
}

export function extractPatchSinceBaseline(baseline: GitPatchBaseline): string | undefined {
  if (!baseline.supported) {
    return undefined;
  }
  const afterDiff = readGitDiff(baseline.workDir);
  if (!afterDiff || !afterDiff.trim()) {
    return undefined;
  }
  if ((baseline.beforeDiff || '') === afterDiff) {
    return undefined;
  }
  if (baseline.beforeDiff && baseline.beforeDiff.trim()) {
    return undefined;
  }
  return afterDiff;
}

export async function materializeCliArtifacts(args: MaterializeCliArtifactsArgs): Promise<MaterializeCliArtifactsResult> {
  const traceFiles: TraceRef[] = [];
  const nativeTraceFiles = args.nativeTraceFiles || [];
  const traceEntries: ArtifactManifestEntry[] = [];

  if (args.normalizedTrace && args.normalizedTrace.length > 0) {
    const normalizedTrace = await writeNormalizedTrace(args.instanceDir, args.normalizedTrace);
    traceFiles.push(normalizedTrace);
    traceEntries.push({
      id: `trace-${traceEntries.length + 1}`,
      kind: 'trajectory',
      path: normalizedTrace.path,
      contentType: 'application/json',
      description: 'Normalized CLI trajectory trace.',
    });
  }
  for (const nativeTraceFile of nativeTraceFiles) {
    const traceFile = await materializeNativeTraceFile(args.instanceDir, nativeTraceFile.sourcePath, nativeTraceFile.targetPath);
    traceFiles.push(traceFile);
    traceEntries.push({
      id: `trace-${traceEntries.length + 1}`,
      kind: 'trajectory',
      path: traceFile.path,
      contentType: nativeTraceFile.contentType || 'application/x-ndjson',
      description: nativeTraceFile.description || 'Native CLI trace artifact.',
    });
  }

  let patchPath: string | undefined;
  if (args.patch) {
    patchPath = path.join(args.artifactsDir, 'patch.diff');
    await fs.promises.mkdir(args.artifactsDir, { recursive: true });
    await fs.promises.writeFile(patchPath, args.patch, 'utf-8');
  }

  const sessionFiles = args.sessionFiles || [];
  const artifactEntries: ArtifactManifestEntry[] = [
    {
      id: 'stdout',
      kind: 'stdout',
      path: args.stdoutPath,
      contentType: 'text/plain',
      description: args.stdoutDescription,
    },
    {
      id: 'stderr',
      kind: 'stderr',
      path: args.stderrPath,
      contentType: 'text/plain',
      description: args.stderrDescription,
    },
    ...(patchPath
      ? [
          {
            id: 'patch',
            kind: 'patch' as const,
            path: patchPath,
            contentType: 'text/x-diff',
            description: args.patchDescription,
          },
        ]
      : []),
    ...sessionFiles.map((sessionFile, index) => ({
      id: `session-${index + 1}`,
      kind: 'session' as const,
      path: sessionFile.path,
      contentType: sessionFile.contentType,
      description: sessionFile.description,
    })),
    ...traceEntries,
  ];

  return {
    artifactManifestPath: await writeArtifactManifest(args.artifactsDir, artifactEntries),
    traceFiles,
  };
}
