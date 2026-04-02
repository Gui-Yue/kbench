import fs from 'fs';
import path from 'path';

export interface ArtifactManifestEntry {
  id: string;
  kind:
    | 'stdout'
    | 'stderr'
    | 'patch'
    | 'trajectory'
    | 'session'
    | 'image'
    | 'recording'
    | 'benchmark-native'
    | 'manifest'
    | 'other';
  path: string;
  contentType?: string;
  description?: string;
}

export interface ArtifactManifest {
  files: ArtifactManifestEntry[];
}

export function resolveMaterializedTargetPath(baseDir: string, relativeTargetPath: string): string {
  const normalized = path.posix.normalize(relativeTargetPath.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe materialized output path: ${relativeTargetPath}`);
  }

  const resolvedBaseDir = path.resolve(baseDir);
  const targetPath = path.resolve(resolvedBaseDir, normalized);
  const relativeToBase = path.relative(resolvedBaseDir, targetPath);
  if (relativeToBase === '' || relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
    throw new Error(`Materialized output path escaped target directory: ${relativeTargetPath}`);
  }

  return targetPath;
}

export async function materializeArtifactFile(
  sourcePath: string,
  artifactsDir: string,
  relativeTargetPath: string
): Promise<string> {
  const targetPath = resolveMaterializedTargetPath(artifactsDir, relativeTargetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
  return targetPath;
}

export async function writeArtifactManifest(artifactsDir: string, files: ArtifactManifestEntry[]): Promise<string> {
  const manifestPath = path.join(artifactsDir, 'manifest.json');
  fs.mkdirSync(artifactsDir, { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify({ files }, null, 2), 'utf-8');
  return manifestPath;
}
