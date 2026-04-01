import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyRetryableError,
  parseModelName,
  readRetryConfig,
  resolveEnvPrefix,
  shouldUseNonStreamingProvider,
} from '../../src/harness/drivers/kode_agent_sdk/shared/provider.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('provider helpers', () => {
  it('parses provider/model pairs and rejects invalid names', () => {
    expect(parseModelName('glm/glm-5')).toEqual({ provider: 'glm', model: 'glm-5' });
    expect(parseModelName('openai/gpt-4.1-mini')).toEqual({ provider: 'openai', model: 'gpt-4.1-mini' });
    expect(() => parseModelName('missing-slash')).toThrow('provider/model');
    expect(() => parseModelName('foo/bar')).toThrow('Unsupported provider prefix');
  });

  it('maps provider prefixes for env lookup', () => {
    expect(resolveEnvPrefix('openai')).toBe('OPENAI');
    expect(resolveEnvPrefix('anthropic')).toBe('ANTHROPIC');
    expect(resolveEnvPrefix('gemini')).toBe('GEMINI');
    expect(resolveEnvPrefix('glm')).toBe('OPENAI');
    expect(resolveEnvPrefix('minimax')).toBe('MINIMAX');
  });

  it('detects retryable provider and transient network errors', () => {
    expect(classifyRetryableError(new Error('OpenAI API error: 429 rate limit'))).toEqual({
      retryable: true,
      reason: 'http_429',
    });
    expect(classifyRetryableError(new Error('Gateway timeout while contacting provider'))).toEqual({
      retryable: true,
      reason: 'transient_network_or_provider_error',
    });
    expect(classifyRetryableError(new Error('OpenAI API error: 400 bad request'))).toEqual({
      retryable: false,
      reason: 'http_400',
    });
  });

  it('reads retry config from environment with sane defaults', () => {
    vi.stubEnv('KODE_BENCH_RETRY_MAX_ATTEMPTS', '5');
    vi.stubEnv('KODE_BENCH_RETRY_INITIAL_DELAY_MS', '1234');
    vi.stubEnv('KODE_BENCH_RETRY_MAX_DELAY_MS', '5678');
    vi.stubEnv('KODE_BENCH_RETRY_BACKOFF_MULTIPLIER', '3');
    vi.stubEnv('KODE_BENCH_RETRY_JITTER_RATIO', '0.5');

    expect(readRetryConfig()).toEqual({
      maxAttempts: 5,
      initialDelayMs: 1234,
      maxDelayMs: 5678,
      backoffMultiplier: 3,
      jitterRatio: 0.5,
    });
  });

  it('chooses non-streaming mode from env override or glm auto-detection', () => {
    vi.stubEnv('KODE_BENCH_STREAMING_MODE', 'non-stream');
    expect(shouldUseNonStreamingProvider('openai/gpt-4.1-mini')).toBe(true);

    vi.stubEnv('KODE_BENCH_STREAMING_MODE', 'stream');
    expect(shouldUseNonStreamingProvider('glm/glm-5')).toBe(false);

    vi.stubEnv('KODE_BENCH_STREAMING_MODE', 'auto');
    expect(shouldUseNonStreamingProvider('glm/glm-5')).toBe(true);
    expect(shouldUseNonStreamingProvider('openai/gpt-4.1-mini')).toBe(false);
  });
});
