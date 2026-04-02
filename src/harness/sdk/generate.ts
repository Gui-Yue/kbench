import fs from 'fs';
import path from 'path';

import type { BenchmarkId, RunMode } from '../../core/protocol.js';
import { adapterManifestTemplate, type AdapterKind, type AdapterManifest } from './manifest.js';
import { validateAdapter, type AdapterValidationReport } from './validate.js';

type SourceType = 'local' | 'remote-url' | 'identifier';
type CommandConfidence = 'high' | 'medium' | 'low';
type HarnessHint =
  | 'generic'
  | 'cli-harness'
  | 'codex'
  | 'claude-code'
  | 'gemini-cli'
  | 'langchain-runner'
  | 'kode-agent-sdk';

export const GENERATOR_HINTS: HarnessHint[] = [
  'generic',
  'cli-harness',
  'codex',
  'claude-code',
  'gemini-cli',
  'langchain-runner',
  'kode-agent-sdk',
];

export const GENERATOR_HINT_DESCRIPTIONS: Record<HarnessHint, string> = {
  generic: 'Generic bootstrap with conservative task-mode defaults.',
  'cli-harness': 'Generic CLI-harness bootstrap for Codex/Gemini/Claude-like external commands.',
  codex: 'CLI-oriented task bootstrap shaped for Codex-like runners.',
  'claude-code': 'CLI-oriented task bootstrap shaped for Claude Code style runners.',
  'gemini-cli': 'Experimental CLI-oriented task bootstrap shaped for Gemini CLI style runners.',
  'langchain-runner': 'Dual-mode bootstrap for LangChain-style local runner scripts.',
  'kode-agent-sdk': 'Dual-mode bootstrap aligned with kode-agent-sdk style task/session execution.',
};

export interface AdapterGenerateOptions {
  repo: string;
  outDir?: string;
  name?: string;
  type?: AdapterKind;
  hint?: HarnessHint;
  validate?: boolean;
}

export interface CommandCandidate {
  command: string;
  origin: string;
  confidence: CommandConfidence;
}

export interface AdapterGenerationReport {
  source: string;
  sourceType: SourceType;
  inferredName: string;
  inferredType: AdapterKind;
  harnessHint: HarnessHint;
  supportedBenchmarks: BenchmarkId[];
  runModes: RunMode[];
  candidateCommands: string[];
  commandDetails: CommandCandidate[];
  recommendedCommand?: string;
  candidateEntrypoints: string[];
  evidence: string[];
  warnings: string[];
  localPath?: string;
}

export interface AdapterGenerateResult {
  adapterDir: string;
  files: string[];
  report: AdapterGenerationReport;
  validation?: AdapterValidationReport;
}

interface SourceInspection {
  source: string;
  sourceType: SourceType;
  baseDir?: string;
  localPath?: string;
  packageName?: string;
  fileNames: string[];
  relativeFiles: string[];
  packageJson?: Record<string, unknown>;
  readmeText?: string;
  pyprojectText?: string;
}

const IGNORED_DIR_NAMES = new Set([
  '.bench',
  '.kbench',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.pytest_cache',
  'runs',
]);
const MAX_SOURCE_FILES = 1200;
const MAX_SOURCE_DEPTH = 4;
const EXCLUDED_ENTRYPOINT_PATTERNS = [
  /^\.tmp\//,
  /^scripts\/bench\//,
  /^src\/harness\/sdk\//,
  /^src\/harness\/templates\//,
  /^src\/core\//,
];

function pathExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

function ensureSafeName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) {
    throw new Error('Generated adapter name is empty. Pass --name explicitly.');
  }
  return normalized;
}

function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function readTextIfExists(filePath: string): string | undefined {
  if (!pathExists(filePath)) return undefined;
  return fs.readFileSync(filePath, 'utf-8');
}

function collectRelativeFiles(baseDir: string, depth = MAX_SOURCE_DEPTH, limit = MAX_SOURCE_FILES): string[] {
  const collected: string[] = [];

  function walk(currentDir: string, currentDepth: number): void {
    if (collected.length >= limit || currentDepth > depth) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (collected.length >= limit) return;
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        walk(fullPath, currentDepth + 1);
        continue;
      }
      if (entry.isFile()) {
        collected.push(relativePath);
      }
    }
  }

  walk(baseDir, 0);
  return collected.sort();
}

function getPackageScriptEntries(packageJson: Record<string, unknown> | undefined): Array<[string, string]> {
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  return Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
}

function getPackageBinEntries(packageJson: Record<string, unknown> | undefined, packageName?: string): Array<[string, string]> {
  const bin = packageJson?.bin;
  if (!bin) return [];
  if (typeof bin === 'string') {
    return packageName ? [[packageName, bin]] : [['bin', bin]];
  }
  if (typeof bin !== 'object' || Array.isArray(bin)) return [];
  return Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
}

function hasCliSignals(source: SourceInspection, corpus: string): boolean {
  if (getPackageBinEntries(source.packageJson, source.packageName).length > 0) {
    return true;
  }
  if (source.relativeFiles.some((file) => /(^|\/)(bin|cli|runner)\//.test(file) || /(^|\/)(cli|runner|main)\.(mjs|js|cjs|ts|py|sh)$/.test(file))) {
    return true;
  }
  return [
    '--help',
    '--version',
    '--prompt',
    '--output-format',
    'stream-json',
    'command line',
    ' cli ',
  ].some((signal) => corpus.includes(signal));
}

function extractPyprojectScriptEntries(pyprojectText?: string): Array<[string, string]> {
  if (!pyprojectText) return [];
  const entries: Array<[string, string]> = [];
  const sectionPattern = /^\[(project\.scripts|tool\.poetry\.scripts)\]\s*$/gm;
  const matches = [...pyprojectText.matchAll(sectionPattern)];
  for (let i = 0; i < matches.length; i += 1) {
    const sectionStart = matches[i].index ?? 0;
    const bodyStart = sectionStart + matches[i][0].length;
    const sectionEnd = i + 1 < matches.length ? (matches[i + 1].index ?? pyprojectText.length) : pyprojectText.length;
    const body = pyprojectText.slice(bodyStart, sectionEnd);
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z0-9._-]+)\s*=\s*["']([^"']+)["']/);
      if (match) {
        entries.push([match[1], match[2]]);
      }
    }
  }
  return entries;
}

function maybeTsRunner(relativePath: string): string {
  return relativePath.endsWith('.ts') ? `npx tsx ${relativePath}` : `node ${relativePath}`;
}

function dedupeCommandCandidates(candidates: CommandCandidate[]): CommandCandidate[] {
  const seen = new Set<string>();
  const rank: Record<CommandConfidence, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  const sorted = [...candidates].sort((a, b) => {
    const confidence = rank[a.confidence] - rank[b.confidence];
    if (confidence !== 0) return confidence;
    return a.command.localeCompare(b.command);
  });
  const deduped: CommandCandidate[] = [];
  for (const candidate of sorted) {
    if (seen.has(candidate.command)) continue;
    seen.add(candidate.command);
    deduped.push(candidate);
  }
  return deduped;
}

function rankCommandCandidate(candidate: CommandCandidate, hint: HarnessHint): number {
  let score = candidate.confidence === 'high' ? 300 : candidate.confidence === 'medium' ? 200 : 100;
  const lower = candidate.command.toLowerCase();
  if (hint === 'codex' && lower.includes('codex')) score += 80;
  if (hint === 'claude-code' && lower.includes('claude')) score += 80;
  if (hint === 'gemini-cli' && lower.includes('gemini')) score += 80;
  if (hint === 'langchain-runner' && (lower.includes('langchain') || lower.includes('runner'))) score += 60;
  if (hint === 'kode-agent-sdk' && (lower.includes('kode') || lower.includes('agent'))) score += 60;
  if (lower.startsWith('npm run ')) score += 20;
  if (lower.startsWith('python3 ')) score += 15;
  if (lower.startsWith('node ') || lower.startsWith('npx ')) score += 10;
  if (lower.includes('src/cli/')) score += 40;
  if (lower.includes('/bin/') || lower.startsWith('bin/')) score += 35;
  if (lower.includes('scripts/bench/') || lower.includes('.tmp/')) score -= 80;
  if (lower.includes('src/harness/sdk/')) score -= 100;
  return score;
}

function inspectLocalSource(sourcePath: string): SourceInspection {
  const resolvedPath = path.resolve(sourcePath);
  const stats = fs.statSync(resolvedPath);
  const baseDir = stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const rootEntries = fs.readdirSync(baseDir);
  const relativeFiles = collectRelativeFiles(baseDir);
  const packageJsonPath = path.join(baseDir, 'package.json');
  const pyprojectPath = path.join(baseDir, 'pyproject.toml');
  const readmePath = ['README.md', 'README', 'readme.md']
    .map((name) => path.join(baseDir, name))
    .find((candidate) => pathExists(candidate));

  let packageJson: Record<string, unknown> | undefined;
  if (pathExists(packageJsonPath)) {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
  }

  return {
    source: sourcePath,
    sourceType: 'local',
    baseDir,
    localPath: resolvedPath,
    packageName: typeof packageJson?.name === 'string' ? packageJson.name : undefined,
    fileNames: rootEntries,
    relativeFiles,
    packageJson,
    readmeText: readmePath ? readTextIfExists(readmePath) : undefined,
    pyprojectText: readTextIfExists(pyprojectPath),
  };
}

function inspectRemoteLikeSource(source: string): SourceInspection {
  let name = source;
  let sourceType: SourceType = 'identifier';
  if (isUrl(source)) {
    sourceType = 'remote-url';
    try {
      const url = new URL(source);
      name = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    } catch {
      name = source;
    }
  }
  return {
    source,
    sourceType,
    packageName: name,
    fileNames: [],
    relativeFiles: [],
  };
}

function getPackageFieldKeys(packageJson: Record<string, unknown> | undefined, key: string): string[] {
  const value = packageJson?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

function inferHarnessHint(source: SourceInspection, corpus: string): HarnessHint {
  const packageName = (source.packageName || '').toLowerCase();
  const dependencyNames = [
    ...getPackageFieldKeys(source.packageJson, 'dependencies'),
    ...getPackageFieldKeys(source.packageJson, 'devDependencies'),
    ...getPackageFieldKeys(source.packageJson, 'peerDependencies'),
  ].map((item) => item.toLowerCase());
  const packageSignals = [packageName, ...dependencyNames].join('\n');

  if (packageSignals.includes('@shareai-lab/kode-sdk') || packageSignals.includes('kode-sdk')) {
    return 'kode-agent-sdk';
  }
  if (hasCliSignals(source, corpus)) return 'cli-harness';
  if (packageSignals.includes('langchain') || corpus.includes('langchain')) return 'langchain-runner';
  if (packageSignals.includes('claude-code') || corpus.includes('claude-code') || corpus.includes('claude code')) {
    return 'claude-code';
  }
  if (packageSignals.includes('codex') || corpus.includes('codex cli') || corpus.includes('openai codex')) {
    return 'codex';
  }
  if (packageSignals.includes('gemini-cli') || corpus.includes('gemini-cli') || corpus.includes('gemini cli')) {
    return 'gemini-cli';
  }
  return 'generic';
}

function inferCandidateCommands(source: SourceInspection, hint: HarnessHint): {
  commands: string[];
  details: CommandCandidate[];
  recommendedCommand?: string;
  entrypoints: string[];
} {
  const candidates: CommandCandidate[] = [];
  const entrypoints = new Set<string>();

  for (const [name, binPath] of getPackageBinEntries(source.packageJson, source.packageName)) {
    if (name && name !== 'bin') {
      candidates.push({
        command: name,
        origin: `package.json#bin:${name}`,
        confidence: 'high',
      });
      candidates.push({
        command: `npx ${name}`,
        origin: `package.json#bin:${name}`,
        confidence: 'medium',
      });
    }
    if (binPath) {
      entrypoints.add(binPath.replace(/\\/g, '/'));
      candidates.push({
        command: binPath.endsWith('.py')
          ? `python3 ${binPath}`
          : maybeTsRunner(binPath),
        origin: `package.json#bin:${name}`,
        confidence: 'medium',
      });
    }
  }

  for (const [name, script] of getPackageScriptEntries(source.packageJson)) {
    const scriptName = name.toLowerCase();
    if (
      /(^|:)(build|bundle|typecheck|test|lint|format|prepare|postinstall|preinstall|clean)(:|$)/.test(scriptName)
      || /\besbuild\b/.test(script)
      || /\btsc\b/.test(script)
      || /\bvitest\b|\bjest\b|\beslint\b|\bprettier\b/.test(script)
    ) {
      continue;
    }
    if (/^(start|cli|run|agent|eval|bench|dev|serve|session|task)$/.test(scriptName)
      || script.includes('langchain')
      || script.includes('agent')
      || script.includes('bench')) {
      candidates.push({
        command: `npm run ${name}`,
        origin: `package.json#scripts.${name}`,
        confidence: /^(start|cli|run|agent|eval|bench)$/.test(scriptName) ? 'high' : 'medium',
      });
    }
  }

  for (const [name, target] of extractPyprojectScriptEntries(source.pyprojectText)) {
    candidates.push({
      command: name,
      origin: `pyproject:${name}`,
      confidence: 'high',
    });
    const moduleName = target.split(':')[0];
    if (moduleName) {
      candidates.push({
        command: `python3 -m ${moduleName}`,
        origin: `pyproject:${name}`,
        confidence: 'medium',
      });
      entrypoints.add(moduleName.replace(/\./g, '/') + '.py');
    }
  }

  for (const relativeFile of source.relativeFiles) {
    const lower = relativeFile.toLowerCase();
    if (EXCLUDED_ENTRYPOINT_PATTERNS.some((pattern) => pattern.test(lower))) {
      continue;
    }
    const baseName = path.basename(lower);
    const isCandidate = /(^|\/)(runner|cli|main|agent|app|server|bench|eval)[^/]*\.(mjs|js|cjs|ts|py|sh)$/.test(lower)
      || /(^|\/)(bin|scripts|src\/bin|src\/cli)\//.test(lower);
    if (!isCandidate) continue;
    entrypoints.add(relativeFile);
    if (baseName.endsWith('.py')) {
      candidates.push({
        command: `python3 ${relativeFile}`,
        origin: `source:${relativeFile}`,
        confidence: /runner|agent|bench|eval/.test(baseName) ? 'high' : 'medium',
      });
    } else if (baseName.endsWith('.sh')) {
      candidates.push({
        command: `bash ${relativeFile}`,
        origin: `source:${relativeFile}`,
        confidence: 'medium',
      });
    } else if (baseName.endsWith('.js') || baseName.endsWith('.mjs') || baseName.endsWith('.cjs') || baseName.endsWith('.ts')) {
      candidates.push({
        command: maybeTsRunner(relativeFile),
        origin: `source:${relativeFile}`,
        confidence: /runner|cli|main|agent/.test(baseName) ? 'high' : 'medium',
      });
    }
  }

  if (candidates.length === 0) {
    if (hint === 'langchain-runner') {
      candidates.push({
        command: 'python3 path/to/langchain_runner.py',
        origin: 'hint-fallback',
        confidence: 'low',
      });
    } else if (hint === 'cli-harness') {
      candidates.push({
        command: 'your-cli-binary',
        origin: 'hint-fallback',
        confidence: 'low',
      });
    } else if (hint === 'gemini-cli') {
      candidates.push({
        command: 'gemini',
        origin: 'hint-fallback',
        confidence: 'low',
      });
    } else if (hint === 'claude-code') {
      candidates.push({
        command: 'claude',
        origin: 'hint-fallback',
        confidence: 'low',
      });
    } else if (hint === 'codex') {
      candidates.push({
        command: 'codex',
        origin: 'hint-fallback',
        confidence: 'low',
      });
    } else if (hint === 'kode-agent-sdk') {
      candidates.push({
        command: 'node path/to/kode_agent_entry.js',
        origin: 'hint-fallback',
        confidence: 'low',
      });
    }
  }

  const details = dedupeCommandCandidates(candidates);
  const recommendedCommand = details.length > 0
    ? [...details].sort((a, b) => rankCommandCandidate(b, hint) - rankCommandCandidate(a, hint))[0]?.command
    : undefined;

  return {
    commands: details.map((candidate) => candidate.command),
    details,
    recommendedCommand,
    entrypoints: [...entrypoints].sort(),
  };
}

function countSignals(corpus: string, patterns: string[]): number {
  return patterns.reduce((total, pattern) => total + (corpus.includes(pattern) ? 1 : 0), 0);
}

function inferExecutionShape(corpus: string, hint: HarnessHint): {
  runModes: RunMode[];
  supportedBenchmarks: BenchmarkId[];
  evidence: string[];
} {
  const evidence: string[] = [];
  const taskScore = countSignals(corpus, ['swe', 'swebench', 'tb2', 'terminal-bench', 'patch', 'diff', 'repository']);
  const sessionScore = countSignals(corpus, ['tau', 'session', 'step', 'tool call', 'action space', 'messages-file', 'tools-file']);

  if (hint === 'kode-agent-sdk') {
    evidence.push('Using kode-agent-sdk profile; enabling both task and session benchmark support.');
    return {
      runModes: ['task', 'session'],
      supportedBenchmarks: ['swe', 'tb2', 'tau'],
      evidence,
    };
  }

  if (hint === 'langchain-runner') {
    evidence.push('Detected langchain-related signals; enabling both task and session bootstrap support.');
    return {
      runModes: ['task', 'session'],
      supportedBenchmarks: ['swe', 'tb2', 'tau'],
      evidence,
    };
  }

  if (hint === 'cli-harness') {
    evidence.push('Using generic CLI-harness profile; defaulting to task benchmarks.');
    return {
      runModes: ['task'],
      supportedBenchmarks: ['swe', 'tb2'],
      evidence,
    };
  }

  if (hint === 'codex' || hint === 'claude-code' || hint === 'gemini-cli') {
    evidence.push(`Using ${hint} CLI profile; defaulting to task benchmarks.`);
    return {
      runModes: ['task'],
      supportedBenchmarks: ['swe', 'tb2'],
      evidence,
    };
  }

  if (sessionScore > 0 && taskScore > 0) {
    evidence.push('Detected both task-style and session-style benchmark signals.');
    return {
      runModes: ['task', 'session'],
      supportedBenchmarks: ['swe', 'tb2', 'tau'],
      evidence,
    };
  }

  if (sessionScore > taskScore) {
    evidence.push('Detected more session-style signals; defaulting to tau/session mode.');
    return {
      runModes: ['session'],
      supportedBenchmarks: ['tau'],
      evidence,
    };
  }

  evidence.push('Defaulting to task-style benchmark support.');
  return {
    runModes: ['task'],
    supportedBenchmarks: taskScore > 0 ? ['swe', 'tb2'] : ['swe'],
    evidence,
  };
}

function inferAdapterKind(source: SourceInspection, hint: HarnessHint, explicitType?: AdapterKind): {
  type: AdapterKind;
  evidence: string[];
} {
  if (explicitType) {
    return {
      type: explicitType,
      evidence: [`Using explicit adapter kind from CLI: ${explicitType}.`],
    };
  }

  if (!source.packageJson) {
    if (hint === 'langchain-runner') {
      return {
        type: 'python',
        evidence: ['Using langchain-runner profile without package.json; choosing python adapter bootstrap.'],
      };
    }
    if (hint === 'cli-harness') {
      return {
        type: 'cli',
        evidence: ['Using cli-harness profile without package.json; choosing cli adapter bootstrap.'],
      };
    }
    if (hint === 'codex' || hint === 'claude-code' || hint === 'gemini-cli') {
      return {
        type: 'cli',
        evidence: [`Using ${hint} profile without package.json; choosing cli adapter bootstrap.`],
      };
    }
    if (hint === 'kode-agent-sdk') {
      return {
        type: 'node',
        evidence: ['Using kode-agent-sdk profile without package.json; choosing node adapter bootstrap.'],
      };
    }
  }

  if (source.packageJson) {
    if (hint === 'cli-harness' || getPackageBinEntries(source.packageJson, source.packageName).length > 0) {
      return {
        type: 'cli',
        evidence: ['Detected package.json bin/CLI signals; choosing cli adapter bootstrap.'],
      };
    }
    return {
      type: 'node',
      evidence: ['Detected package.json; choosing node adapter bootstrap.'],
    };
  }

  if (source.pyprojectText || source.fileNames.some((fileName) => fileName.endsWith('.py'))) {
    return {
      type: 'python',
      evidence: ['Detected Python project signals; choosing python adapter bootstrap.'],
    };
  }

  if (hint === 'cli-harness' || hint === 'gemini-cli' || hint === 'claude-code' || hint === 'codex') {
    return {
      type: 'cli',
      evidence: [`Detected ${hint} CLI-style signals; choosing cli adapter bootstrap.`],
    };
  }

  return {
    type: 'node',
    evidence: ['Falling back to node adapter bootstrap.'],
  };
}

function renderRunner(kind: AdapterKind, report: AdapterGenerationReport): string {
  const metadataJson = JSON.stringify(report, null, 2);
  const metadataBlock = metadataJson.split('\n').map((line) => `// ${line}`).join('\n');
  const shellMetadataBlock = metadataJson.split('\n').map((line) => `# ${line}`).join('\n');

  if (kind === 'cli') {
    if (report.harnessHint === 'cli-harness') {
      return `#!/usr/bin/env bash
set -euo pipefail

# Generated by kbench adapter generate.
${shellMetadataBlock}

if [[ -n "\${KBENCH_ADAPTER_INPUT:-}" ]]; then
  input_path="$KBENCH_ADAPTER_INPUT"
else
  input_path="$(mktemp)"
  cat > "$input_path"
fi

recommended_command="${report.recommendedCommand || ''}"
cli_command="\${KBENCH_CLI_COMMAND:-}"
cli_prompt_flag="\${KBENCH_CLI_PROMPT_FLAG:---prompt}"
cli_model_flag="\${KBENCH_CLI_MODEL_FLAG:---model}"
cli_output_flag="\${KBENCH_CLI_OUTPUT_FLAG:---output-format}"
cli_output_value="\${KBENCH_CLI_OUTPUT_VALUE:-text}"
cli_extra_args="\${KBENCH_CLI_EXTRA_ARGS:-}"
artifact_dir="$(mktemp -d)"
stdout_path="$artifact_dir/stdout.txt"
stderr_path="$artifact_dir/stderr.txt"
instruction_file="$artifact_dir/instruction.txt"

python3 - "$input_path" "$instruction_file" <<'PY'
import json
import pathlib
import sys

payload = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
instruction = payload.get('task', {}).get('instruction') or ''
pathlib.Path(sys.argv[2]).write_text(instruction, encoding='utf-8')
PY

if [[ -z "$cli_command" ]]; then
  python3 - <<'PY'
import json
import sys

json.dump({
    "ok": True,
    "status": "ok",
    "finalText": "cli-harness stub response",
    "elapsedMs": 1,
    "artifacts": [],
    "benchmarkResult": {
        "mode": "stub",
        "message": "Set KBENCH_CLI_COMMAND to invoke the real CLI harness.",
        "recommendedCommand": ${JSON.stringify(report.recommendedCommand || null)},
    },
}, sys.stdout)
PY
  exit 0
fi

read -r -a cli_parts <<< "$cli_command"
if [[ \${#cli_parts[@]} -eq 0 ]]; then
  echo '{"ok":false,"status":"invalid_adapter","elapsedMs":1,"error":{"message":"KBENCH_CLI_COMMAND resolved to an empty command."}}'
  exit 0
fi

read -r -a extra_parts <<< "$cli_extra_args"
mapfile -t parsed_values < <(python3 - "$input_path" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print(payload.get('mode', 'task'))
print(payload.get('config', {}).get('modelName') or '')
PY
)
mode="\${parsed_values[0]:-task}"
model_name="\${parsed_values[1]:-}"

if [[ "$mode" != "task" ]]; then
  echo '{"ok":false,"status":"unsupported_capability","elapsedMs":1,"error":{"message":"Generated cli-harness adapter currently supports task mode only."}}'
  exit 0
fi

cmd=("\${cli_parts[@]}")
if [[ -n "$cli_prompt_flag" ]]; then
  cmd+=("$cli_prompt_flag" "$(cat "$instruction_file")")
fi
if [[ -n "$cli_model_flag" && -n "$model_name" ]]; then
  cmd+=("$cli_model_flag" "$model_name")
fi
if [[ -n "$cli_output_flag" && -n "$cli_output_value" ]]; then
  cmd+=("$cli_output_flag" "$cli_output_value")
fi
if [[ \${#extra_parts[@]} -gt 0 ]]; then
  cmd+=("\${extra_parts[@]}")
fi

start_ts="$(date +%s%3N)"
set +e
"\${cmd[@]}" >"$stdout_path" 2>"$stderr_path"
exit_code=$?
set -e
end_ts="$(date +%s%3N)"
elapsed_ms=$((end_ts - start_ts))

python3 - "$stdout_path" "$stderr_path" "$elapsed_ms" "$exit_code" <<'PY'
import json
import pathlib
import sys

stdout_path, stderr_path, elapsed_ms, exit_code = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
stdout_text = pathlib.Path(stdout_path).read_text(encoding='utf-8', errors='ignore')
stderr_text = pathlib.Path(stderr_path).read_text(encoding='utf-8', errors='ignore')
lines = [line.strip() for line in stdout_text.splitlines() if line.strip()]
final_text = lines[-1] if lines else stdout_text.strip() or None
result = {
    "ok": exit_code == 0,
    "status": "ok" if exit_code == 0 else "agent_error",
    "failureKind": None if exit_code == 0 else f"exit_{exit_code}",
    "finalText": final_text,
    "elapsedMs": elapsed_ms,
    "artifacts": [
        {"kind": "stdout", "path": stdout_path, "contentType": "text/plain", "description": "CLI harness stdout."},
        {"kind": "stderr", "path": stderr_path, "contentType": "text/plain", "description": "CLI harness stderr."},
    ],
    "benchmarkResult": {
        "mode": "cli-harness",
        "exitCode": exit_code,
    },
}
if exit_code != 0:
    result["error"] = {"message": stderr_text.strip() or final_text or f"CLI exited with code {exit_code}"}
json.dump(result, sys.stdout)
PY
`;
    }
    return `#!/usr/bin/env bash
set -euo pipefail

# Generated by kbench adapter generate.
${shellMetadataBlock}

if [[ -n "\${KBENCH_ADAPTER_INPUT:-}" ]]; then
  input="$(cat "$KBENCH_ADAPTER_INPUT")"
else
  input="$(cat)"
fi

# TODO:
# 1. Replace the stub with your real harness invocation.
# 2. Translate the harness output into the AdapterRunnerOutput JSON schema.
# 3. If you have native transcripts or logs, return them via trace.native/artifacts.

if printf '%s' "$input" | grep -q '"mode":"session"'; then
  cat <<'EOF'
{"ok":true,"status":"ok","action":"respond(sample)","finalText":"generated session stub response","elapsedMs":1,"artifacts":[]}
EOF
else
  cat <<'EOF'
{"ok":true,"status":"ok","finalText":"generated task stub response","elapsedMs":1,"artifacts":[]}
EOF
fi
`;
  }

  if (kind === 'python') {
    return `#!/usr/bin/env python3
import json
import os
import sys

# Generated by kbench adapter generate.
# Inference report:
${metadataJson.split('\n').map((line) => `# ${line}`).join('\n')}


def main() -> None:
    if os.environ.get("KBENCH_ADAPTER_INPUT"):
        with open(os.environ["KBENCH_ADAPTER_INPUT"], "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = json.load(sys.stdin)

    # TODO:
    # 1. Invoke the real harness entrypoint.
    # 2. Normalize task/session outputs into AdapterRunnerOutput.
    # 3. Emit trace.normalized / trace.native when available.
    mode = payload.get("mode")
    if mode == "session":
        result = {
            "ok": True,
            "status": "ok",
            "action": "respond(sample)",
            "finalText": "generated session stub response",
            "elapsedMs": 1,
            "artifacts": [],
        }
    else:
        result = {
            "ok": True,
            "status": "ok",
            "finalText": "generated task stub response",
            "elapsedMs": 1,
            "artifacts": [],
        }
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
`;
  }

  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

// Generated by kbench adapter generate.
// Inference report:
${metadataBlock}

const input = process.env.KBENCH_ADAPTER_INPUT
  ? readFileSync(process.env.KBENCH_ADAPTER_INPUT, 'utf8')
  : readFileSync(0, 'utf8');
const payload = JSON.parse(input || '{}');

// TODO:
// 1. Call the real harness entrypoint or local script.
// 2. Normalize the harness output into AdapterRunnerOutput.
// 3. Attach trace.normalized / trace.native when available.
const result = payload.mode === 'session'
  ? {
      ok: true,
      status: 'ok',
      action: 'respond(sample)',
      finalText: 'generated session stub response',
      elapsedMs: 1,
      artifacts: [],
    }
  : {
      ok: true,
      status: 'ok',
      finalText: 'generated task stub response',
      elapsedMs: 1,
      artifacts: [],
    };

process.stdout.write(JSON.stringify(result));
`;
}

function buildManifest(name: string, kind: AdapterKind, report: AdapterGenerationReport): AdapterManifest {
  const entry = kind === 'cli'
    ? './runner.sh'
    : kind === 'python'
      ? './runner.py'
      : './runner.mjs';

  return {
    ...adapterManifestTemplate,
    id: name,
    kind,
    entry,
    version: '0.1.0',
    supportedBenchmarks: report.supportedBenchmarks,
    capabilities: {
      ...adapterManifestTemplate.capabilities,
      runModes: report.runModes,
      supportsPatchOutput: report.runModes.includes('task'),
      supportsTrajectory: report.runModes.includes('session') || report.harnessHint === 'langchain-runner',
      supportsToolCallTrace: kind !== 'cli',
    },
  };
}

function renderReadme(name: string, manifest: AdapterManifest, report: AdapterGenerationReport): string {
  const lines = [
    `# ${name}`,
    '',
    'This adapter was generated by `kbench adapter generate`.',
    '',
    '## Source',
    '',
    `- source: \`${report.source}\``,
    `- sourceType: \`${report.sourceType}\``,
    `- harnessHint: \`${report.harnessHint}\``,
    `- adapterKind: \`${report.inferredType}\``,
    `- runModes: \`${report.runModes.join(', ')}\``,
    `- supportedBenchmarks: \`${report.supportedBenchmarks.join(', ')}\``,
    ...(report.recommendedCommand ? [`- recommendedCommand: \`${report.recommendedCommand}\``] : []),
    '',
    '## Candidate Commands',
    '',
    ...(report.commandDetails.length > 0
      ? report.commandDetails.map((candidate) => `- \`${candidate.command}\` (${candidate.confidence}, ${candidate.origin})`)
      : ['- No command candidates were inferred automatically.']),
    '',
    '## Candidate Entrypoints',
    '',
    ...(report.candidateEntrypoints.length > 0
      ? report.candidateEntrypoints.map((entry) => `- \`${entry}\``)
      : ['- No concrete source entrypoints were inferred automatically.']),
    '',
    '## Files',
    '',
    '- `adapter.manifest.json`',
    `- \`${manifest.entry.replace('./', '')}\``,
    '- `adapter.generate.json`',
    '- `adapter.validate.json`',
    '',
    '## Next Steps',
    '',
    '1. Replace the stub runner with the real harness bridge.',
    '2. Adjust `supportedBenchmarks`, `runModes`, and capability flags.',
    '3. If available, export `trace.normalized` and `trace.native`.',
    `4. Re-run \`kbench adapter validate --adapter ${name}\` after replacing the stub runner.`,
  ];

  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', '', ...report.warnings.map((warning) => `- ${warning}`));
  }

  return `${lines.join('\n')}\n`;
}

async function writeFile(targetPath: string, content: string, executable = false): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, content, 'utf-8');
  if (executable) {
    await fs.promises.chmod(targetPath, 0o755);
  }
}

function inspectSource(repo: string): SourceInspection {
  if (pathExists(repo)) {
    return inspectLocalSource(repo);
  }
  return inspectRemoteLikeSource(repo);
}

export async function generateAdapter(options: AdapterGenerateOptions): Promise<AdapterGenerateResult> {
  const source = inspectSource(options.repo);
  const corpus = [
    source.packageName || '',
    source.fileNames.join(' '),
    source.relativeFiles.join(' '),
    source.readmeText || '',
    source.pyprojectText || '',
    source.packageJson ? JSON.stringify(source.packageJson) : '',
  ].join('\n').toLowerCase();

  const hint = options.hint || inferHarnessHint(source, corpus);
  const kindInference = inferAdapterKind(source, hint, options.type);
  const shapeInference = inferExecutionShape(corpus, hint);
  const inferredName = ensureSafeName(options.name || source.packageName || path.basename(options.repo));
  const candidateInference = inferCandidateCommands(source, hint);
  const warnings: string[] = [];

  if (source.sourceType !== 'local') {
    warnings.push('Remote repo URLs are not fetched automatically. This generator used only the provided identifier/URL text.');
  }
  if (candidateInference.commands.length === 0) {
    warnings.push('No concrete command candidates were detected. Update the runner stub manually.');
  }

  const report: AdapterGenerationReport = {
    source: options.repo,
    sourceType: source.sourceType,
    inferredName,
    inferredType: kindInference.type,
    harnessHint: hint,
    supportedBenchmarks: shapeInference.supportedBenchmarks,
    runModes: shapeInference.runModes,
    candidateCommands: candidateInference.commands,
    commandDetails: candidateInference.details,
    recommendedCommand: candidateInference.recommendedCommand,
    candidateEntrypoints: candidateInference.entrypoints,
    evidence: [
      ...(options.hint ? [`Using explicit generator hint from CLI: ${options.hint}.`] : []),
      ...kindInference.evidence,
      ...shapeInference.evidence,
    ],
    warnings,
    localPath: source.localPath,
  };

  const adapterDir = path.resolve(options.outDir || path.join(process.cwd(), inferredName));
  if (fs.existsSync(adapterDir)) {
    const entries = fs.readdirSync(adapterDir);
    if (entries.length > 0) {
      throw new Error(`Target adapter directory is not empty: ${adapterDir}`);
    }
  }

  await fs.promises.mkdir(adapterDir, { recursive: true });

  const manifest = buildManifest(inferredName, kindInference.type, report);
  const runnerName = manifest.entry.replace('./', '');
  const manifestPath = path.join(adapterDir, 'adapter.manifest.json');
  const runnerPath = path.join(adapterDir, runnerName);
  const readmePath = path.join(adapterDir, 'README.md');
  const reportPath = path.join(adapterDir, 'adapter.generate.json');
  const validationPath = path.join(adapterDir, 'adapter.validate.json');

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(runnerPath, renderRunner(kindInference.type, report), true);
  await writeFile(readmePath, renderReadme(inferredName, manifest, report));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const shouldValidate = options.validate !== false;
  let validation: AdapterValidationReport | undefined;
  if (shouldValidate) {
    validation = await validateAdapter(adapterDir);
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  }

  return {
    adapterDir,
    files: [
      manifestPath,
      runnerPath,
      readmePath,
      reportPath,
      ...(validation ? [validationPath] : []),
    ],
    report,
    validation,
  };
}
