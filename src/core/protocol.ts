export type BenchmarkId = 'swe' | 'tb2' | 'tau' | 'sae';

export type DriverKind =
  | 'sdk'
  | 'cli'
  | 'python'
  | 'node'
  | 'workflow';

export type RunMode = 'task' | 'session';

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MountSpec {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface InputAttachment {
  name: string;
  path: string;
  mediaType?: string;
}

export interface EnvSpec {
  workdir?: string;
  repoPath?: string;
  sandbox?: {
    type: 'host' | 'container' | 'benchmark-native';
    image?: string;
  };
  tools?: ToolSpec[];
  envVars?: Record<string, string>;
  mounts?: MountSpec[];
}

export interface TaskEnvelope {
  benchmark: BenchmarkId;
  instanceId: string;
  title?: string;
  instruction: string;
  metadata?: Record<string, unknown>;
  env: EnvSpec;
  attachments?: InputAttachment[];
}

export interface SessionSpec {
  benchmark: BenchmarkId;
  instanceId: string;
  metadata?: Record<string, unknown>;
  env: EnvSpec;
  initialObservation: Record<string, unknown>;
  actionSpace?: Record<string, unknown>;
}

export interface HarnessCapability {
  runModes: RunMode[];
  machineReadableStdout: boolean;
  supportsPatchOutput: boolean;
  supportsTrajectory: boolean;
  supportsToolCallTrace: boolean;
  supportsResume: boolean;
  supportsImages: boolean;
  supportsSandboxBridge: boolean;
  supportsPromptTemplate: boolean;
}
