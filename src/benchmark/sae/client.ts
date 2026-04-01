import type {
  SaeAgentProfile,
  SaeRegisterAgentRequest,
  SaeSubmissionResult,
  SaeSubmissionStart,
  SaeSubmitAnswersRequest,
} from './types.js';

export class SaeApiError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(message: string, status: number, bodyText: string) {
    super(message);
    this.name = 'SaeApiError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

interface SaeClientOptions {
  apiBase: string;
  requestTimeoutMs?: number;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export class SaeClient {
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;

  constructor(options: SaeClientOptions) {
    this.apiBase = trimTrailingSlash(options.apiBase);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const url = `${this.apiBase}${pathname}`;
    const headers = new Headers(init?.headers || {});
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const bodyText = await response.text();

    if (!response.ok) {
      throw new SaeApiError(
        `SAE API request failed with ${response.status} ${response.statusText}`,
        response.status,
        bodyText
      );
    }

    if (!bodyText.trim()) {
      return {} as T;
    }

    return JSON.parse(bodyText) as T;
  }

  async registerAgent(input: SaeRegisterAgentRequest): Promise<SaeAgentProfile> {
    return this.request<SaeAgentProfile>('/agentExamAgent', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async startSubmission(apiToken: string): Promise<SaeSubmissionStart> {
    return this.request<SaeSubmissionStart>('/agentExamSubmission', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: '{}',
    });
  }

  async submitAnswers(
    submissionId: string,
    input: SaeSubmitAnswersRequest,
    apiToken: string
  ): Promise<SaeSubmissionResult> {
    return this.request<SaeSubmissionResult>(`/agentExamSubmission/${submissionId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(input),
    });
  }

  async getSubmission(submissionId: string, apiToken: string): Promise<SaeSubmissionResult> {
    return this.request<SaeSubmissionResult>(`/agentExamSubmission/${submissionId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });
  }

  async getAgent(agentId: string, apiToken?: string): Promise<SaeAgentProfile> {
    const headers: Record<string, string> = {};
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
    }
    return this.request<SaeAgentProfile>(`/agentExamAgent/${agentId}`, {
      method: 'GET',
      headers,
    });
  }
}
