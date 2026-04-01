import type { SummaryResult } from '../../core/results.js';

export interface SaeQuestion {
  id: string;
  text: string;
}

export interface SaeAgentCredentials {
  agentId: string;
  apiToken: string;
}

export interface SaeRegisterAgentRequest {
  name: string;
  model: string;
  version: string;
  description?: string;
  agentType: string;
}

export interface SaeAgentProfile {
  agentId: string;
  name: string;
  model: string;
  version?: string;
  description?: string;
  agentType?: string;
  registeredAt?: string;
  submissions?: SaeSubmissionResult[];
  apiToken?: string;
}

export interface SaeSubmissionStart {
  submissionId: string;
  status: string;
  startedAt?: string;
  timeLimitMinutes?: number;
  questions: SaeQuestion[];
}

export interface SaeSubmissionResult {
  submissionId: string;
  status: string;
  score?: number;
  maxScore?: number;
  percentage?: number;
  passed?: boolean;
  certificateId?: string;
  startedAt?: string;
  submittedAt?: string;
  timeLimitMinutes?: number;
  questions?: SaeQuestion[];
}

export interface SaeSubmitAnswersRequest {
  answers: Record<string, string>;
}

export interface SaeBenchmarkConfig {
  runId: string;
  runDir: string;
  harness: string;
  modelName: string;
  baseUrl?: string;
  workDir?: string;
  storeDir?: string;
  saeApiBase: string;
  saeAgentIdFile: string;
  saeApiKeyFile: string;
  saeRegisterIfMissing: boolean;
  saeAgentName?: string;
  saeAgentDescription?: string;
  saeAgentVersion: string;
  saeAgentType: string;
  saeTimeoutMs?: number;
  saePollIntervalMs: number;
}

export interface SaeBenchmarkOutcome {
  completed: boolean;
  runDir: string;
  runId: string;
  summary: SummaryResult;
  profileUrl?: string;
  submission?: SaeSubmissionResult;
  agent?: SaeAgentProfile;
  benchmarkError?: {
    failureKind: string;
    message: string;
  };
}
