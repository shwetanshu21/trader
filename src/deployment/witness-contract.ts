// ── Deployment Witness Contract ──
// A machine-checkable contract for the CAX11 on-host deployment-witness bundle.
//
// Every deployment-witness artifact bundle under data/artifacts/deployment-witness/<run-id>/
// MUST satisfy this contract. The contract defines:
//   - Bundle layout and required filenames
//   - Subsystem inventory (runtime, notifier, MCP bridge, Caddy, SQLite, logs, artifacts)
//   - Path witness shape
//   - Host/application evidence metadata
//   - Steady-state witness types (time-series resource samples, process/HTTP/disk evidence)
//   - Verdict derivation (pass / caveat / fail with explicit reasoning)
//   - Redaction rules (secrets never written to artifacts)
//   - Fail-closed status semantics (missing required evidence = contract failure)
//
// Redaction philosophy: preserve enough metadata to prove a subsystem exists and is
// reachable, but never persist bearer tokens, basic-auth secrets, cookie values, or
// any value whose redacted form would expose >4 chars of the original secret.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for the deployment-witness manifest. Bump on breaking changes. */
export const DEPLOYMENT_WITNESS_SCHEMA_VERSION = 1;

/** Root directory for deployment-witness artifacts, relative to project root. */
export const ARTIFACTS_ROOT = 'data/artifacts/deployment-witness';

/** Required evidence filenames inside a witness bundle. */
export const REQUIRED_BUNDLE_FILES = [
  'manifest.json',
] as const;

/** Required subsystem identifiers that must appear in every manifest. */
export const REQUIRED_SUBSYSTEMS = [
  'runtime',
  'notifier',
  'mcp-bridge',
  'operator-ui',
  'caddy',
  'sqlite',
  'logs',
  'artifacts',
] as const;

/** Set of required subsystem IDs for fast lookup. */
const REQUIRED_SUBSYSTEM_SET: ReadonlySet<string> = new Set(REQUIRED_SUBSYSTEMS);

/** Fields whose raw values MUST be redacted or excluded before serialization. */
const SECRET_BEARING_FIELD_NAMES = new Set([
  'access_token',
  'token',
  'bearer',
  'authorization',
  'auth_header',
  'cookie',
  'session_id',
  'api_key',
  'apikey',
  'secret',
  'password',
  'basic_auth',
  'basic-auth',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single subsystem entry in the witness manifest. */
export interface SubsystemRecord {
  /** Canonical subsystem identifier (one of REQUIRED_SUBSYSTEMS). */
  id: string;
  /** Human-readable label for the subsystem. */
  label: string;
  /** Whether this subsystem was reachable and responding at capture time. */
  reachable: boolean;
  /** Whether evidence for this subsystem is hard-required for the bundle to be valid. */
  required: boolean;
  /** Optional free-form evidence metadata (redacted before write). */
  metadata?: RedactedMap;
}

/**
 * Path witness — records where a subsystem's persistent paths live on the host.
 * Redaction: only the directory and filename are stored; no secrets from file contents.
 */
export interface PathWitness {
  /** Human-readable label for the path (e.g. "SQLite database", "Notifier token file"). */
  label: string;
  /** Absolute or relative filesystem path (redacted for secret-containing files). */
  path: string;
  /** Whether the path exists on disk at capture time. */
  exists: boolean;
  /** File size in bytes (0 if does not exist). */
  sizeBytes: number;
  /** Last-modified timestamp (epoch ms, 0 if does not exist). */
  mtimeMs: number;
  /** Optional sub-paths or directory listing (deeply redacted). */
  children?: RedactedPathEntry[];
}

/**
 * A single path entry in a directory listing.
 * Individual filenames with secret-like names are masked.
 */
export interface RedactedPathEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
}

/**
 * A map-like structure where values containing secrets are masked before serialization.
 */
export interface RedactedMap {
  [key: string]: unknown;
}

/** Host evidence — OS-level snapshot of the deployment host. */
export interface HostEvidence {
  /** Hostname (redacted to first 8 chars + hash suffix). */
  hostname: string;
  /** OS platform (darwin, linux, win32). */
  platform: string;
  /** OS release string. */
  release: string;
  /** Architecture (arm64, x64). */
  arch: string;
  /** Total system memory in bytes. */
  totalMemoryBytes: number;
  /** Free memory at capture time in bytes. */
  freeMemoryBytes: number;
  /** CPU model name. */
  cpuModel: string;
  /** Number of logical CPUs. */
  cpuCores: number;
  /** Load average (1-minute). */
  loadAverage1m: number;
  /** Uptime of the host in seconds. */
  hostUptimeSec: number;
}

/** Application evidence — aggregate health and status summary across subsystems. */
export interface AppEvidence {
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Overall verdict: 'healthy' if all required subsystems are reachable, 'degraded' otherwise. */
  verdict: 'healthy' | 'degraded';
  /** Number of subsystems attested. */
  subsystemCount: number;
  /** Names of subsystems that were unreachable. */
  unreachableSubsystems: string[];
}

/** Optional per-subsystem annotations that do not affect required-evidence checks. */
export interface OptionalAnnotation {
  /** Free-form label. */
  label: string;
  /** Arbitrary JSON-serializable value (redacted if secret-bearing). */
  value: unknown;
}

/** Reachability record for one operator-ui route. */
export interface OperatorUiRouteWitness {
  /** Human-readable route label. */
  label: string;
  /** Route path relative to the base URL. */
  path: string;
  /** HTTP status code (0 when unreachable). */
  statusCode: number;
  /** Whether the route responded with an expected status for this probe. */
  reachable: boolean;
  /** Whether this route is expected to require auth. */
  authProtected: boolean;
  /** Whether the route challenged correctly with Basic auth. */
  challenged: boolean;
  /** Advertised Basic realm, if present. */
  challengeRealm: string | null;
  /** Error string when the route did not respond as expected. */
  error: string | null;
}

/** Host-local and optional proxy evidence for the operator UI. */
export interface OperatorUiSubsystemMetadata extends RedactedMap {
  /** Host-local base URL that should reach the real service bind. */
  hostLocalBaseUrl: string;
  /** Route prefix under which the UI is served. */
  servicePath: string;
  /** Health endpoint used for the required host-local probe. */
  healthEndpoint: string;
  /** Whether the required host-local health endpoint returned a truthful payload. */
  healthReachable: boolean;
  /** HTTP status returned by the host-local health endpoint. */
  healthStatusCode: number;
  /** Parsed operator-ui status field when available. */
  healthStatus: string | null;
  /** Parsed dbConnected field when available. */
  dbConnected: boolean | null;
  /** Operator-ui route checks performed against the host-local service. */
  routeWitnesses: OperatorUiRouteWitness[];
  /** Optional proxied-entrypoint annotations that never gate bundle validity. */
  proxyEvidence: {
    configured: boolean;
    optional: true;
    baseUrl: string | null;
    servicePath: string | null;
    healthStatusCode: number;
    healthReachable: boolean;
    protectedChallengeOk: boolean | null;
    error: string | null;
  };
}

// ---------------------------------------------------------------------------
// Steady-state witness types
// ---------------------------------------------------------------------------

/**
 * A single time-series resource sample taken at a point in time.
 * Records host-level CPU/memory/load and optionally disk usage for tracked paths.
 */
export interface ResourceSample {
  /** ISO timestamp when the sample was taken. */
  timestamp: string;
  /** Total system memory in bytes. */
  totalMemoryBytes: number;
  /** Free memory at sample time in bytes. */
  freeMemoryBytes: number;
  /** Used memory (total - free) in bytes. */
  usedMemoryBytes: number;
  /** Memory usage fraction (0-1). */
  memoryUsageFraction: number;
  /** Load average (1-minute). */
  loadAverage1m: number;
  /** Load average (5-minute). */
  loadAverage5m: number;
  /** Load average (15-minute). */
  loadAverage15m: number;
  /** CPU model (constant across samples, included for auditing). */
  cpuModel: string;
  /** Number of logical CPUs. */
  cpuCores: number;
  /** Disk usage snapshots keyed by label. */
  diskUsage?: Record<string, DiskSnapshot>;
  /** Host uptime in seconds at sample time. */
  hostUptimeSec: number;
}

/** A single disk/directory size snapshot. */
export interface DiskSnapshot {
  /** Path being measured. */
  path: string;
  /** Total size in bytes (recursive for directories). */
  sizeBytes: number;
  /** Whether the path exists at sample time. */
  exists: boolean;
}

/** Result of a process presence check. */
export interface ProcessProbe {
  /** Process name or pattern that was searched for. */
  processName: string;
  /** Whether the process appears to be running. */
  running: boolean;
  /** PID if found, or null. */
  pid: number | null;
  /** Error message if the check failed, or null. */
  error: string | null;
}

/** Result of a single HTTP health/resource probe. */
export interface HttpProbe {
  /** URL that was probed. */
  url: string;
  /** Whether the probe succeeded (HTTP 2xx). */
  success: boolean;
  /** HTTP status code (0 if unreachable). */
  statusCode: number;
  /** Response time in milliseconds. */
  responseTimeMs: number;
  /** ISO timestamp when the probe was taken. */
  timestamp: string;
  /** Error message if the probe failed, or null. */
  error: string | null;
}

/** Time-series record of a tracked file or directory's size over the witness window. */
export interface GrowthRecord {
  /** Human-readable label (e.g. "SQLite database", "Application logs"). */
  label: string;
  /** Path being tracked. */
  path: string;
  /** Initial size at the start of the window. */
  startSizeBytes: number;
  /** Final size at the end of the window. */
  endSizeBytes: number;
  /** Net growth in bytes (negative means shrank). */
  growthBytes: number;
  /** Growth rate in bytes/hour over the witness window. */
  growthBytesPerHour: number;
  /** Whether the path existed at both start and end. */
  existedThroughout: boolean;
  /** Samples taken during the window (optional, for detailed analysis). */
  samples?: Array<{ timestamp: string; sizeBytes: number }>;
}

/** Subsystem-specific evidence collected during a steady-state run. */
export interface SubsystemEvidence {
  /** Subsystem identifier (e.g. "runtime", "notifier", "mcp-bridge"). */
  subsystemId: string;
  /** Human-readable label. */
  label: string;
  /** Whether the subsystem was healthy throughout the witness window. */
  healthyThroughout: boolean;
  /** HTTP probe history for this subsystem. */
  probes: HttpProbe[];
  /** If unhealthy, a human-readable reason for the missing evidence. */
  missingEvidenceReason: string | null;
  /** Additional evidence metadata (redacted before serialization). */
  metadata?: RedactedMap;
}

/** Verdict for the overall steady-state witness. */
export type SteadyStateVerdictValue = 'pass' | 'caveat' | 'fail';

/** Structured verdict with reasoning and subsystem-level detail. */
export interface SteadyStateVerdict {
  /** Overall verdict. */
  verdict: SteadyStateVerdictValue;
  /** One-sentence summary of the verdict. */
  summary: string;
  /** Detailed reasoning — what was observed, what was missing, what drifted. */
  reasoning: string;
  /** Individual subsystem verdicts. */
  subsystemVerdicts: SubsystemVerdict[];
  /** List of specific concerns raised during the witness window. */
  concerns: string[];
  /** Number of required subsystems that were unhealthy throughout. */
  degradedRequiredCount: number;
  /** Number of subsystems with no evidence at all (missing probes). */
  missingEvidenceCount: number;
}

/** Per-subsystem verdict. */
export interface SubsystemVerdict {
  /** Subsystem identifier. */
  subsystemId: string;
  /** Whether this subsystem's evidence is healthy. */
  healthy: boolean;
  /** Specific note about this subsystem's state. */
  note: string;
  /** Reason if evidence is missing entirely. */
  missingEvidenceReason: string | null;
}

/** Top-level steady-state deployment witness manifest. */
export interface SteadyStateWitnessManifest {
  schemaVersion: number;
  artifactType: 'steady-state-witness';
  /** ISO timestamp when the witness run started. */
  startedAt: string;
  /** ISO timestamp when the witness run ended. */
  endedAt: string;
  /** Duration of the witness window in seconds. */
  durationSec: number;
  /** Sampling interval in seconds. */
  intervalSec: number;
  /** Unique run identifier. */
  runId: string;
  /** Human-readable label. */
  label: string;
  /** Time-series resource samples collected during the window. */
  resourceSamples: ResourceSample[];
  /** Resource summary computed from samples. */
  resourceSummary: ResourceSummary;
  /** Process presence evidence. */
  processEvidence: ProcessProbe[];
  /** HTTP health probe evidence per subsystem. */
  subsystemEvidence: SubsystemEvidence[];
  /** Growth/drift records for tracked persistent paths. */
  growthRecords: GrowthRecord[];
  /** Structured verdict. */
  verdict: SteadyStateVerdict;
  /** Annotations (redacted). */
  annotations: OptionalAnnotation[];
}

/** Aggregate resource summary computed from time-series samples. */
export interface ResourceSummary {
  /** Number of samples taken. */
  sampleCount: number;
  /** Memory usage statistics. */
  memory: {
    /** Average used memory in bytes. */
    avgUsedBytes: number;
    /** Minimum used memory in bytes. */
    minUsedBytes: number;
    /** Maximum used memory in bytes. */
    maxUsedBytes: number;
    /** Average memory usage fraction (0-1). */
    avgUsageFraction: number;
    /** Peak memory usage fraction (0-1). */
    peakUsageFraction: number;
  };
  /** CPU load statistics. */
  load: {
    /** Average 1-minute load. */
    avgLoad1m: number;
    /** Peak 1-minute load. */
    peakLoad1m: number;
    /** Average 5-minute load. */
    avgLoad5m: number;
    /** Average 15-minute load. */
    avgLoad15m: number;
  };
  /** Disk growth statistics. */
  disk: {
    /** Total growth across all tracked paths in bytes. */
    totalGrowthBytes: number;
    /** Paths with the highest growth rates. */
    highestGrowthPaths: Array<{ label: string; growthBytesPerHour: number }>;
  };
}

/** Top-level deployment-witness manifest structure. */
export interface DeploymentWitnessManifest {
  schemaVersion: number;
  artifactType: 'deployment-witness';
  /** ISO timestamp when the bundle was captured. */
  capturedAt: string;
  /** Unique run identifier (typically timestamp-based or run ID). */
  runId: string;
  /** Human-readable label for this run. */
  label: string;
  /** Subsystem inventory. */
  subsystems: SubsystemRecord[];
  /** Path witnesses for each subsystem's persistent files. */
  pathWitnesses: PathWitness[];
  /** Host evidence. */
  hostEvidence: HostEvidence;
  /** Application evidence. */
  appEvidence: AppEvidence;
  /** Optional annotations (redacted). */
  annotations: OptionalAnnotation[];
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Mask a secret value, preserving only a short prefix and suffix.
 * Returns the original value if it is not a string or is too short.
 */
export function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length <= 4) return '***';
  if (value.length <= 12) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

/**
 * Recursively scan an object and mask any value whose key matches a known
 * secret-bearing field name. Returns a new object — the original is not mutated.
 */
export function redactMap(input: Record<string, unknown>): RedactedMap {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const keyLower = key.toLowerCase().replace(/[_-]/g, '_');

    if (SECRET_BEARING_FIELD_NAMES.has(keyLower)) {
      // Mask the value if it's a string
      output[key] = maskSecret(value);
      continue;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      output[key] = redactMap(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      output[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? redactMap(item as Record<string, unknown>)
          : item,
      );
    } else {
      output[key] = value;
    }
  }

  return output;
}

/**
 * Redact a hostname for safe serialization.
 * Keeps the first 8 chars and appends a short hash suffix to distinguish hosts
 * without revealing the full hostname.
 */
export function redactHostname(rawHostname: string): string {
  if (!rawHostname) return 'unknown';
  const short = rawHostname.slice(0, 8);
  // Simple stable hash from the full hostname for distinguishability
  let hash = 0;
  for (let i = 0; i < rawHostname.length; i++) {
    const c = rawHostname.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0; // Convert to 32-bit integer
  }
  const hashStr = Math.abs(hash).toString(16).slice(0, 6);
  return `${short}-${hashStr}`;
}

/**
 * Safely serialize a manifest to JSON with secret redaction.
 * All secret-bearing fields are masked before serialization.
 * Throws if any field would leak raw secret data.
 */
export function serializeManifest(manifest: DeploymentWitnessManifest): string {
  // Deep-clone and redact
  const redacted = JSON.parse(JSON.stringify(manifest));
  redacted.subsystems = redacted.subsystems.map((s: SubsystemRecord) => ({
    ...s,
    metadata: s.metadata ? redactMap(s.metadata as Record<string, unknown>) : undefined,
  }));
  redacted.hostEvidence.hostname = redactHostname(redacted.hostEvidence.hostname);
  redacted.annotations = redacted.annotations.map((a: OptionalAnnotation) => ({
    label: a.label,
    value: typeof a.value === 'object' && a.value !== null
      ? redactMap(a.value as Record<string, unknown>)
      : a.value,
  }));

  return JSON.stringify(redacted, null, 2);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a manifest satisfies the witness contract.
 * Returns an array of violation messages. An empty array means the manifest is valid.
 *
 * Validation rules:
 * 1. Schema version must match DEPLOYMENT_WITNESS_SCHEMA_VERSION
 * 2. artifactType must be 'deployment-witness'
 * 3. All REQUIRED_SUBSYSTEMS must be present in the subsystems array
 * 4. Each required subsystem must have `required: true`
 * 5. Runnable evidence fields must be populated
 * 6. No secret-bearing field values leak in plaintext
 */
export function validateManifest(manifest: unknown): string[] {
  const violations: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    violations.push('Manifest must be a non-null object');
    return violations;
  }

  const m = manifest as Record<string, unknown>;

  // Schema version
  if (m.schemaVersion !== DEPLOYMENT_WITNESS_SCHEMA_VERSION) {
    violations.push(
      `Schema version must be ${DEPLOYMENT_WITNESS_SCHEMA_VERSION}, got ${String(m.schemaVersion)}`,
    );
  }

  // Artifact type
  if (m.artifactType !== 'deployment-witness') {
    violations.push(
      `artifactType must be 'deployment-witness', got ${String(m.artifactType)}`,
    );
  }

  // Required metadata
  if (!m.capturedAt || typeof m.capturedAt !== 'string') {
    violations.push('capturedAt must be a non-empty ISO timestamp string');
  }

  if (!m.runId || typeof m.runId !== 'string') {
    violations.push('runId must be a non-empty string');
  }

  // Subsystems
  if (!Array.isArray(m.subsystems)) {
    violations.push('subsystems must be an array');
  } else {
    const subsystems = m.subsystems as Array<Record<string, unknown>>;
    const subsystemIds = new Set(subsystems.map(s => s.id));

    for (const requiredId of REQUIRED_SUBSYSTEMS) {
      if (!subsystemIds.has(requiredId)) {
        violations.push(`Required subsystem '${requiredId}' is missing from manifest`);
      }
    }

    // Check each required subsystem has required:true
    for (const sub of subsystems) {
      if (typeof sub.id !== 'string') {
        violations.push('Each subsystem must have a string id');
        continue;
      }
      if (REQUIRED_SUBSYSTEM_SET.has(sub.id)) {
        if (sub.required !== true) {
          violations.push(
            `Required subsystem '${String(sub.id)}' must have required: true`,
          );
        }
      }
    }

    const operatorUiSubsystem = subsystems.find(sub => sub.id === 'operator-ui');
    if (operatorUiSubsystem) {
      const metadata = operatorUiSubsystem.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        violations.push("Required subsystem 'operator-ui' must include metadata");
      } else {
        const mdata = metadata as Record<string, unknown>;
        if (typeof mdata.hostLocalBaseUrl !== 'string' || !mdata.hostLocalBaseUrl) {
          violations.push("operator-ui metadata.hostLocalBaseUrl is required");
        }
        if (typeof mdata.servicePath !== 'string') {
          violations.push("operator-ui metadata.servicePath is required");
        }
        if (typeof mdata.healthEndpoint !== 'string' || !mdata.healthEndpoint) {
          violations.push("operator-ui metadata.healthEndpoint is required");
        }
        if (typeof mdata.healthReachable !== 'boolean') {
          violations.push("operator-ui metadata.healthReachable must be a boolean");
        }
        if (typeof mdata.healthStatusCode !== 'number') {
          violations.push("operator-ui metadata.healthStatusCode must be a number");
        }
        if (!Array.isArray(mdata.routeWitnesses) || mdata.routeWitnesses.length === 0) {
          violations.push("operator-ui metadata.routeWitnesses must be a non-empty array");
        }
        if (!mdata.proxyEvidence || typeof mdata.proxyEvidence !== 'object' || Array.isArray(mdata.proxyEvidence)) {
          violations.push("operator-ui metadata.proxyEvidence is required");
        } else {
          const proxy = mdata.proxyEvidence as Record<string, unknown>;
          if (proxy.optional !== true) {
            violations.push("operator-ui metadata.proxyEvidence.optional must be true");
          }
          if (typeof proxy.configured !== 'boolean') {
            violations.push("operator-ui metadata.proxyEvidence.configured must be a boolean");
          }
        }
      }
    }
  }

  // Path witnesses
  if (!Array.isArray(m.pathWitnesses)) {
    violations.push('pathWitnesses must be an array');
  }

  // Host evidence
  if (!m.hostEvidence || typeof m.hostEvidence !== 'object') {
    violations.push('hostEvidence must be a non-null object');
  } else {
    const he = m.hostEvidence as Record<string, unknown>;
    for (const field of ['hostname', 'platform', 'arch', 'totalMemoryBytes', 'cpuCores']) {
      if (he[field] === undefined || he[field] === null) {
        violations.push(`hostEvidence.${field} is required`);
      }
    }
  }

  // App evidence
  if (!m.appEvidence || typeof m.appEvidence !== 'object') {
    violations.push('appEvidence must be a non-null object');
  } else {
    const ae = m.appEvidence as Record<string, unknown>;
    if (!ae.capturedAt) violations.push('appEvidence.capturedAt is required');
    if (!ae.verdict) violations.push('appEvidence.verdict is required');
    if (ae.subsystemCount === undefined || ae.subsystemCount === null) {
      violations.push('appEvidence.subsystemCount is required');
    }
    if (!Array.isArray(ae.unreachableSubsystems)) {
      violations.push('appEvidence.unreachableSubsystems must be an array');
    }
  }

  // Annotations
  if (!Array.isArray(m.annotations)) {
    violations.push('annotations must be an array');
  }

  return violations;
}

/**
 * High-level check: does the manifest have evidence for all required subsystems?
 * Returns `true` only if every required subsystem has `required: true` AND `reachable: true`.
 */
export function hasRequiredEvidence(manifest: DeploymentWitnessManifest): boolean {
  if (!Array.isArray(manifest.subsystems)) return false;

  for (const sub of manifest.subsystems) {
    if (REQUIRED_SUBSYSTEM_SET.has(sub.id)) {
      if (!sub.required) return false;
      if (!sub.reachable) return false;
    }
  }

  // Check every required subsystem was seen
  const seenIds = new Set(manifest.subsystems.map(s => s.id));
  for (const requiredId of REQUIRED_SUBSYSTEMS) {
    if (!seenIds.has(requiredId)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Steady-state contract functions
// ---------------------------------------------------------------------------

/**
 * Compute aggregate resource summary from an array of time-series samples.
 * Returns statistical aggregates for memory, load, and disk growth.
 */
export function computeResourceSummary(samples: ResourceSample[]): ResourceSummary {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      memory: { avgUsedBytes: 0, minUsedBytes: 0, maxUsedBytes: 0, avgUsageFraction: 0, peakUsageFraction: 0 },
      load: { avgLoad1m: 0, peakLoad1m: 0, avgLoad5m: 0, avgLoad15m: 0 },
      disk: { totalGrowthBytes: 0, highestGrowthPaths: [] },
    };
  }

  const usedValues = samples.map(s => s.usedMemoryBytes);
  const fracValues = samples.map(s => s.memoryUsageFraction);
  const load1Values = samples.map(s => s.loadAverage1m);
  const load5Values = samples.map(s => s.loadAverage5m);
  const load15Values = samples.map(s => s.loadAverage15m);

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = (arr: number[]) => Math.max(...arr);
  const min = (arr: number[]) => Math.min(...arr);

  // Disk: compute total growth from first-to-last sample on each tracked path
  const growthByLabel = new Map<string, number>();
  const firstDisk = samples.find(s => s.diskUsage);
  const lastDisk = samples.filter(s => s.diskUsage).pop();

  if (firstDisk?.diskUsage && lastDisk?.diskUsage) {
    const allLabels = new Set([
      ...Object.keys(firstDisk.diskUsage),
      ...Object.keys(lastDisk.diskUsage),
    ]);
    for (const label of allLabels) {
      const first = firstDisk.diskUsage[label];
      const last = lastDisk.diskUsage[label];
      if (first && last && first.exists && last.exists) {
        growthByLabel.set(label, last.sizeBytes - first.sizeBytes);
      }
    }
  }

  const totalGrowthBytes = Array.from(growthByLabel.values()).reduce((a, b) => a + b, 0);

  // Highest growth paths (top 3)
  const sortedGrowth = Array.from(growthByLabel.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([label, bytes]) => ({
      label,
      growthBytesPerHour: samples.length > 1
        ? bytes / ((new Date(samples[samples.length - 1].timestamp).getTime() -
            new Date(samples[0].timestamp).getTime()) / 3_600_000)
        : 0,
    }));

  return {
    sampleCount: samples.length,
    memory: {
      avgUsedBytes: Math.round(avg(usedValues)),
      minUsedBytes: Math.round(min(usedValues)),
      maxUsedBytes: Math.round(max(usedValues)),
      avgUsageFraction: Math.round(avg(fracValues) * 1000) / 1000,
      peakUsageFraction: Math.round(max(fracValues) * 1000) / 1000,
    },
    load: {
      avgLoad1m: Math.round(avg(load1Values) * 100) / 100,
      peakLoad1m: Math.round(max(load1Values) * 100) / 100,
      avgLoad5m: Math.round(avg(load5Values) * 100) / 100,
      avgLoad15m: Math.round(avg(load15Values) * 100) / 100,
    },
    disk: {
      totalGrowthBytes,
      highestGrowthPaths: sortedGrowth,
    },
  };
}

/**
 * Derive a steady-state verdict from subsystem evidence, resource samples, and growth records.
 *
 * Verdict rules:
 *   - 'fail': Any required subsystem has zero successful probes throughout the window
 *             (i.e. missingEvidenceReason is non-null for any required subsystem).
 *   - 'caveat': Any required subsystem had unhealthy periods (not healthy throughout)
 *               OR memory usage exceeded 80% at any point
 *               OR load average exceeded CPU core count at any point
 *               OR any path grew faster than 50 MB/hour.
 *   - 'pass': All required subsystems healthy throughout, resource usage within bounds.
 */
export function deriveSteadyStateVerdict(
  subsystemEvidence: SubsystemEvidence[],
  resourceSummary: ResourceSummary,
  growthRecords: GrowthRecord[],
  requiredSubsystemIds: string[],
): SteadyStateVerdict {
  const concerns: string[] = [];
  const subsystemVerdicts: SubsystemVerdict[] = [];

  let anyRequiredMissingEvidence = false;
  let anyRequiredNotHealthy = false;

  for (const se of subsystemEvidence) {
    const isRequired = requiredSubsystemIds.includes(se.subsystemId);
    const hasMissingEvidence = se.missingEvidenceReason !== null;

    const note: string[] = [];
    if (!se.healthyThroughout) note.push('not healthy throughout');
    if (se.probes.length === 0) note.push('no probes taken');
    if (hasMissingEvidence) note.push(`missing evidence: ${se.missingEvidenceReason}`);

    subsystemVerdicts.push({
      subsystemId: se.subsystemId,
      healthy: se.healthyThroughout && !hasMissingEvidence,
      note: note.length > 0 ? note.join('; ') : 'healthy throughout',
      missingEvidenceReason: se.missingEvidenceReason,
    });

    if (isRequired) {
      if (hasMissingEvidence) {
        anyRequiredMissingEvidence = true;
        concerns.push(`Required subsystem '${se.subsystemId}' has no evidence: ${se.missingEvidenceReason}`);
      } else if (!se.healthyThroughout) {
        anyRequiredNotHealthy = true;
        concerns.push(`Required subsystem '${se.subsystemId}' was not healthy throughout the window`);
      }
    }
  }

  // Check resource usage
  if (resourceSummary.memory.peakUsageFraction > 0.8) {
    concerns.push(
      `Memory usage peaked at ${Math.round(resourceSummary.memory.peakUsageFraction * 100)}%, exceeding 80% threshold`,
    );
  }

  if (resourceSummary.load.peakLoad1m > 4) {
    concerns.push(
      `Load average peaked at ${resourceSummary.load.peakLoad1m}, exceeding the current witness core count threshold (4)`,
    );
  }

  // Check growth rates
  for (const gr of growthRecords) {
    if (gr.growthBytesPerHour > 50 * 1024 * 1024) {
      // > 50 MB/hour
      concerns.push(
        `'${gr.label}' grew at ${(gr.growthBytesPerHour / 1024 / 1024).toFixed(1)} MB/hour, exceeding 50 MB/hour threshold`,
      );
    }
  }

  // Derive overall verdict
  let verdict: SteadyStateVerdictValue;
  let summary: string;
  let reasoning: string;

  if (anyRequiredMissingEvidence) {
    verdict = 'fail';
    summary = `Required subsystem(s) have no evidence: ${subsystemEvidence
      .filter(s => requiredSubsystemIds.includes(s.subsystemId) && s.missingEvidenceReason !== null)
      .map(s => s.subsystemId)
      .join(', ')}`;
    reasoning = concerns.join('; ');
  } else if (anyRequiredNotHealthy || concerns.length > 0) {
    verdict = 'caveat';
    summary = `All required subsystems have evidence but ${concerns.length} concern(s) require operator review`;
    reasoning = concerns.join('; ');
  } else {
    verdict = 'pass';
    summary = 'All required subsystems healthy throughout, resource usage within bounds';
    reasoning = 'No concerns detected during the witness window';
  }

  return {
    verdict,
    summary,
    reasoning,
    subsystemVerdicts,
    concerns,
    degradedRequiredCount: subsystemVerdicts.filter(
      sv => requiredSubsystemIds.includes(sv.subsystemId) && !sv.healthy,
    ).length,
    missingEvidenceCount: subsystemVerdicts.filter(sv => sv.missingEvidenceReason !== null).length,
  };
}

/**
 * Validate a steady-state witness manifest against the contract.
 * Returns an array of violation messages; empty array means valid.
 */
export function validateSteadyStateManifest(manifest: unknown): string[] {
  const violations: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    violations.push('Manifest must be a non-null object');
    return violations;
  }

  const m = manifest as Record<string, unknown>;

  if (m.schemaVersion !== DEPLOYMENT_WITNESS_SCHEMA_VERSION) {
    violations.push(`Schema version must be ${DEPLOYMENT_WITNESS_SCHEMA_VERSION}, got ${String(m.schemaVersion)}`);
  }

  if (m.artifactType !== 'steady-state-witness') {
    violations.push(`artifactType must be 'steady-state-witness', got ${String(m.artifactType)}`);
  }

  if (!m.startedAt || typeof m.startedAt !== 'string') {
    violations.push('startedAt must be a non-empty ISO timestamp string');
  }

  if (!m.endedAt || typeof m.endedAt !== 'string') {
    violations.push('endedAt must be a non-empty ISO timestamp string');
  }

  if (typeof m.durationSec !== 'number' || (m.durationSec as number) <= 0) {
    violations.push('durationSec must be a positive number');
  }

  if (typeof m.intervalSec !== 'number' || (m.intervalSec as number) <= 0) {
    violations.push('intervalSec must be a positive number');
  }

  if (!m.runId || typeof m.runId !== 'string') {
    violations.push('runId must be a non-empty string');
  }

  // Resource samples
  if (!Array.isArray(m.resourceSamples)) {
    violations.push('resourceSamples must be an array');
  } else {
    const samples = m.resourceSamples as Array<Record<string, unknown>>;
    if (samples.length === 0) {
      violations.push('resourceSamples must not be empty');
    }
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!s.timestamp) violations.push(`resourceSamples[${i}].timestamp is required`);
      if (typeof s.totalMemoryBytes !== 'number') violations.push(`resourceSamples[${i}].totalMemoryBytes must be a number`);
      if (typeof s.freeMemoryBytes !== 'number') violations.push(`resourceSamples[${i}].freeMemoryBytes must be a number`);
    }
  }

  // Resource summary
  if (!m.resourceSummary || typeof m.resourceSummary !== 'object') {
    violations.push('resourceSummary must be a non-null object');
  }

  // Process evidence
  if (!Array.isArray(m.processEvidence)) {
    violations.push('processEvidence must be an array');
  }

  // Subsystem evidence
  if (!Array.isArray(m.subsystemEvidence)) {
    violations.push('subsystemEvidence must be an array');
  } else {
    const subs = m.subsystemEvidence as Array<Record<string, unknown>>;
    if (subs.length === 0) {
      violations.push('subsystemEvidence must not be empty');
    }
  }

  // Growth records
  if (!Array.isArray(m.growthRecords)) {
    violations.push('growthRecords must be an array');
  }

  // Verdict
  if (!m.verdict || typeof m.verdict !== 'object') {
    violations.push('verdict must be a non-null object');
  } else {
    const v = m.verdict as Record<string, unknown>;
    if (!['pass', 'caveat', 'fail'].includes(v.verdict as string)) {
      violations.push(`verdict.verdict must be 'pass', 'caveat', or 'fail', got ${String(v.verdict)}`);
    }
    if (!v.summary || typeof v.summary !== 'string') {
      violations.push('verdict.summary is required');
    }
    if (!Array.isArray(v.concerns)) {
      violations.push('verdict.concerns must be an array');
    }
  }

  // Annotations
  if (!Array.isArray(m.annotations)) {
    violations.push('annotations must be an array');
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Build a path witness for a file or directory.
 * Reads filesystem metadata; does NOT read file contents.
 */
export function buildPathWitness(
  label: string,
  targetPath: string,
  withChildren = false,
): PathWitness {
  let exists = false;
  let sizeBytes = 0;
  let mtimeMs = 0;
  let children: RedactedPathEntry[] | undefined;

  try {
    const stat = fs.statSync(targetPath);
    exists = true;
    sizeBytes = stat.size;
    mtimeMs = stat.mtimeMs;

    if (withChildren && stat.isDirectory()) {
      children = fs.readdirSync(targetPath).map(name => {
        const childPath = path.join(targetPath, name);
        let childStat: fs.Stats;
        try {
          childStat = fs.statSync(childPath);
        } catch {
          childStat = { size: 0, isDirectory: () => false } as fs.Stats;
        }
        return {
          name,
          isDirectory: childStat.isDirectory(),
          sizeBytes: childStat.size,
        };
      });
    }
  } catch {
    // Path does not exist — leave defaults
  }

  return { label, path: targetPath, exists, sizeBytes, mtimeMs, children };
}

/**
 * Create the full bundle path for a given run ID under the artifacts root.
 */
export function bundlePath(runId: string): string {
  return path.join(ARTIFACTS_ROOT, runId);
}

/**
 * Ensure the bundle directory exists.
 */
export function ensureBundleDir(runId: string): string {
  const dir = bundlePath(runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
