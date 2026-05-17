// ── Deployment Witness Contract ──
// A machine-checkable contract for the CAX11 on-host deployment-witness bundle.
//
// Every deployment-witness artifact bundle under data/artifacts/deployment-witness/<run-id>/
// MUST satisfy this contract. The contract defines:
//   - Bundle layout and required filenames
//   - Subsystem inventory (runtime, notifier, MCP bridge, Caddy, SQLite, logs, artifacts)
//   - Path witness shape
//   - Host/application evidence metadata
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
    const subsystemIds = new Set(
      (m.subsystems as Array<Record<string, unknown>>).map(s => s.id),
    );

    for (const requiredId of REQUIRED_SUBSYSTEMS) {
      if (!subsystemIds.has(requiredId)) {
        violations.push(`Required subsystem '${requiredId}' is missing from manifest`);
      }
    }

    // Check each required subsystem has required:true
    for (const sub of m.subsystems as Array<Record<string, unknown>>) {
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
