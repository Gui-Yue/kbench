import type { BenchmarkId, DriverKind, HarnessCapability } from '../core/protocol.js';

export interface HarnessDescriptor {
  id: string;
  kind: DriverKind;
  description: string;
  supportedBenchmarks: BenchmarkId[];
  capabilities: HarnessCapability;
}

export interface ProbeCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  command: string;
  detectedVersion?: string;
  capabilities?: Partial<HarnessCapability>;
  checks?: ProbeCheck[];
  errors?: string[];
  warnings?: string[];
}
