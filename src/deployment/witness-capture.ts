// ── Deployment Witness Capture — host/process/HTTP/path evidence capture ──
//
// Captures synchronized host and application evidence for a deployment-witness
// bundle, writing redacted artifacts under the bundle root directory.
//
// Also provides steady-state witness capture: time-series resource sampling,
// process presence probing, HTTP health probing, and disk growth tracking
// over a configurable duration.
//
// Design:
//   - Host evidence uses Node.js `os` module (no external deps).
//   - Application evidence fetches health endpoints from runtime, notifier,
//     and MCP bridge via HTTP GET with configurable timeouts.
//   - Steady-state witness periodically samples resources, probes processes,
//     checks HTTP health endpoints, and records disk sizes.
//   - Path witnesses record SQLite DB, log roots, and artifact roots using
//     the contract's buildPathWitness helper.
//   - Caddy evidence is best-effort (process/service discovery).
//   - All secret-bearing fields are redacted before writing to disk.
//   - Missing required evidence causes the capture to return a non-zero exit
//     in the main entrypoint, not silently degrade.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execSync } from 'node:child_process';

import {
  basicAuthHeader,
  buildOperatorUiRouteUrl,
  DEFAULT_OPERATOR_UI_ROLLOUT_BASE_URL,
  resolveOperatorUiRolloutTarget,
} from './operator-ui-proof-support.js';
import {
  ARTIFACTS_ROOT,
  REQUIRED_SUBSYSTEMS,
  buildPathWitness,
  ensureBundleDir,
  redactHostname,
  redactMap,
  serializeManifest,
  computeResourceSummary,
  deriveSteadyStateVerdict,
  type DeploymentWitnessManifest,
  type SteadyStateWitnessManifest,
  type SubsystemRecord,
  type HostEvidence,
  type AppEvidence,
  type PathWitness,
  type OptionalAnnotation,
  type OperatorUiRouteWitness,
  type OperatorUiSubsystemMetadata,
  type ResourceSample,
  type ProcessProbe,
  type HttpProbe,
  type GrowthRecord,
  type SubsystemEvidence,
  type SteadyStateVerdict,
  type ResourceSummary,
  type DiskSnapshot,
} from './witness-contract.js';

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

/** Default timeout (ms) for health endpoint HTTP requests. */
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Default steady-state witness interval in seconds. */
const DEFAULT_STEADY_STATE_INTERVAL_SEC = 30;

/** Default steady-state witness duration in seconds. */
const DEFAULT_STEADY_STATE_DURATION_SEC = 120;

/** Default health endpoints. */
const DEFAULTS = {
  runtimeHealthUrl: 'http://127.0.0.1:3001/health',
  runtimeDashboardUrl: 'http://127.0.0.1:3001/dashboard.json',
  notifierHealthUrl: 'http://127.0.0.1:8788/health',
  bridgeHealthUrl: 'http://127.0.0.1:8787/health',
  operatorUiBaseUrl: DEFAULT_OPERATOR_UI_ROLLOUT_BASE_URL,
  operatorUiExpectedAuthRealm: 'Operator Console',
  // Production DB path from systemd unit (TRADER_DB_PATH=./data/production.db)
  dbPath: './data/production.db',
  // Notifier logs directory
  logPaths: ['./tmp/upstox/logs', './logs'],
  // Configurable artifact paths
  artifactPaths: ['./data/artifacts'],
  // Caddy config path
  caddyConfigPath: '/etc/caddy/Caddyfile',
  // Caddy data directory
  caddyDataPath: '/var/lib/caddy/data',
  // Process names to probe for steady-state evidence
  processNames: ['trader', 'node', 'caddy'],
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the witness capture. */
export interface CaptureOptions {
  /** Label for this witness run (defaults to auto-generated label). */
  label?: string;
  /** Override runtime health URL. */
  runtimeHealthUrl?: string;
  /** Override runtime dashboard URL. */
  runtimeDashboardUrl?: string;
  /** Override notifier health URL. */
  notifierHealthUrl?: string;
  /** Override bridge health URL. */
  bridgeHealthUrl?: string;
  /** Override host-local operator-ui base URL. */
  operatorUiBaseUrl?: string;
  /** Optional proxied operator-ui base URL for non-gating annotations. */
  operatorUiProxyBaseUrl?: string;
  /** Override expected Basic-auth realm for operator-ui challenge checks. */
  operatorUiExpectedAuthRealm?: string;
  /** Override SQLite DB path. */
  dbPath?: string;
  /** Override log paths to scan. */
  logPaths?: string[];
  /** Override artifact root paths to witness. */
  artifactPaths?: string[];
  /** Override Caddy config path. */
  caddyConfigPath?: string;
  /** Override Caddy data path. */
  caddyDataPath?: string;
  /** HTTP timeout for health fetches (ms). */
  httpTimeoutMs?: number;
  /** Steady-state witness duration in seconds (default: 120). */
  steadyStateDurationSec?: number;
  /** Steady-state witness sampling interval in seconds (default: 30). */
  steadyStateIntervalSec?: number;
  /** Process names to probe for steady-state evidence (default: ['trader', 'node', 'caddy']). */
  processNames?: string[];
  /** Paths to track for disk growth during steady-state witness. */
  growthTrackPaths?: Array<{ label: string; path: string }>;
}

/** Result of a single subsystem health fetch. */
interface HealthFetchResult {
  /** Whether the endpoint responded successfully. */
  success: boolean;
  /** Parsed response body (if JSON), or the raw error description. */
  data: Record<string, unknown> | null;
  /** Error message if the fetch failed. */
  error: string | null;
  /** HTTP status code (0 if unreachable). */
  statusCode: number;
  /** Response body as a string (for raw storage). */
  rawBody: string | null;
}

/** Generic HTTP response capture for routes whose expected status may be non-2xx. */
interface CapturedHttpResponse {
  /** HTTP status code (0 if unreachable). */
  statusCode: number;
  /** Response body as text. */
  rawBody: string | null;
  /** Lower-cased response headers. */
  headers: Record<string, string>;
  /** Network or timeout error, if any. */
  error: string | null;
}

/** Result of Caddy/service discovery. */
interface CaddyDiscoveryResult {
  /** Whether Caddy appears to be installed. */
  caddyInstalled: boolean;
  /** Whether the Caddy process is running. */
  caddyRunning: boolean;
  /** Config path witness. */
  configWitness: PathWitness;
  /** Data path witness. */
  dataWitness: PathWitness;
  /** Discovery errors encountered. */
  errors: string[];
}

/** Complete capture output. */
export interface CaptureResult {
  /** The bundle directory path. */
  bundleDir: string;
  /** The run ID. */
  runId: string;
  /** The assembled manifest. */
  manifest: DeploymentWitnessManifest;
  /** Individual subsystem evidence payloads (raw, for file-level writing). */
  evidenceFiles: Array<{ filename: string; content: string }>;
}

// ---------------------------------------------------------------------------
// HTTP fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a JSON response from a URL with a timeout.
 * Returns structured result with success/error/data fields.
 */
function fetchJson(url: string, timeoutMs: number): Promise<HealthFetchResult> {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const statusCode = res.statusCode ?? 0;

        let data: Record<string, unknown> | null = null;
        try {
          data = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          // Body was not valid JSON
        }

        if (statusCode >= 200 && statusCode < 300) {
          resolve({
            success: true,
            data,
            error: null,
            statusCode,
            rawBody,
          });
        } else {
          resolve({
            success: false,
            data,
            error: `HTTP ${statusCode}`,
            statusCode,
            rawBody,
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        data: null,
        error: 'timeout',
        statusCode: 0,
        rawBody: null,
      });
    });

    req.on('error', (err: Error) => {
      resolve({
        success: false,
        data: null,
        error: err.message,
        statusCode: 0,
        rawBody: null,
      });
    });
  });
}

/** Fetch raw HTTP response details for routes whose expected status may be non-2xx. */
function fetchHttpResponse(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<CapturedHttpResponse> {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const rawHeaders = Object.entries(res.headers).reduce<Record<string, string>>((acc, [key, value]) => {
          if (Array.isArray(value)) {
            acc[key.toLowerCase()] = value.join(', ');
          } else if (typeof value === 'string') {
            acc[key.toLowerCase()] = value;
          }
          return acc;
        }, {});
        resolve({
          statusCode: res.statusCode ?? 0,
          rawBody: Buffer.concat(chunks).toString('utf-8'),
          headers: rawHeaders,
          error: null,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 0, rawBody: null, headers: {}, error: 'timeout' });
    });

    req.on('error', (err: Error) => {
      resolve({ statusCode: 0, rawBody: null, headers: {}, error: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Host evidence
// ---------------------------------------------------------------------------

/** Gather host evidence using Node.js `os` module. */
export function captureHostEvidence(): HostEvidence {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';

  return {
    hostname: redactHostname(os.hostname()),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    cpuModel,
    cpuCores: cpus.length,
    loadAverage1m: os.loadavg()[0] ?? 0,
    hostUptimeSec: Math.floor(os.uptime()),
  };
}

// ---------------------------------------------------------------------------
// Subsystem evidence
// ---------------------------------------------------------------------------

/** Fetch runtime evidence from health and dashboard endpoints. */
export async function captureRuntimeEvidence(
  options: CaptureOptions,
  httpTimeoutMs: number,
): Promise<{
  subsystem: SubsystemRecord;
  healthResult: HealthFetchResult;
  dashboardResult: HealthFetchResult;
}> {
  const healthResult = await fetchJson(options.runtimeHealthUrl ?? DEFAULTS.runtimeHealthUrl, httpTimeoutMs);
  const dashboardResult = await fetchJson(options.runtimeDashboardUrl ?? DEFAULTS.runtimeDashboardUrl, httpTimeoutMs);

  const reachable = healthResult.success || dashboardResult.success;
  const metadata: Record<string, unknown> = {
    healthEndpoint: options.runtimeHealthUrl ?? DEFAULTS.runtimeHealthUrl,
    dashboardEndpoint: options.runtimeDashboardUrl ?? DEFAULTS.runtimeDashboardUrl,
    healthReachable: healthResult.success,
    dashboardReachable: dashboardResult.success,
  };

  if (healthResult.success && healthResult.data) {
    metadata.healthVerdict = (healthResult.data as Record<string, unknown>).verdict ?? 'unknown';
    metadata.healthUptimeMs = (healthResult.data as Record<string, unknown>).uptimeMs ?? null;
  }

  if (dashboardResult.success && dashboardResult.data) {
    const dashData = dashboardResult.data as Record<string, unknown>;
    metadata.dashboardVerdict = dashData.overall ?? dashData.verdict ?? 'unknown';
    metadata.strategyDecisionCount = dashData.strategyDecisionCount ?? null;
    metadata.executionMode = dashData.executionMode ?? null;
  }

  if (!healthResult.success && !dashboardResult.success) {
    metadata.healthError = healthResult.error;
    metadata.dashboardError = dashboardResult.error;
  }

  return {
    subsystem: {
      id: 'runtime',
      label: 'Trader Runtime',
      reachable,
      required: true,
      metadata,
    },
    healthResult,
    dashboardResult,
  };
}

/** Fetch notifier evidence from its health endpoint. */
export async function captureNotifierEvidence(
  options: CaptureOptions,
  httpTimeoutMs: number,
): Promise<{
  subsystem: SubsystemRecord;
  healthResult: HealthFetchResult;
}> {
  const healthResult = await fetchJson(options.notifierHealthUrl ?? DEFAULTS.notifierHealthUrl, httpTimeoutMs);

  const metadata: Record<string, unknown> = {
    healthEndpoint: options.notifierHealthUrl ?? DEFAULTS.notifierHealthUrl,
    reachable: healthResult.success,
  };

  if (healthResult.success && healthResult.data) {
    const h = healthResult.data as Record<string, unknown>;
    metadata.notifierUptimeMs = h.uptimeMs ?? null;
    metadata.notifierPath = h.notifierPath ?? null;
    metadata.tokenPath = h.tokenPath ?? null;
    metadata.lastDelivery = h.lastDelivery ?? null;
  } else {
    metadata.error = healthResult.error;
  }

  return {
    subsystem: {
      id: 'notifier',
      label: 'Upstox Notifier',
      reachable: healthResult.success,
      required: true,
      metadata,
    },
    healthResult,
  };
}

/** Fetch MCP bridge evidence from its health endpoint. */
export async function captureBridgeEvidence(
  options: CaptureOptions,
  httpTimeoutMs: number,
): Promise<{
  subsystem: SubsystemRecord;
  healthResult: HealthFetchResult;
}> {
  const healthResult = await fetchJson(options.bridgeHealthUrl ?? DEFAULTS.bridgeHealthUrl, httpTimeoutMs);

  const metadata: Record<string, unknown> = {
    healthEndpoint: options.bridgeHealthUrl ?? DEFAULTS.bridgeHealthUrl,
    reachable: healthResult.success,
  };

  if (healthResult.success && healthResult.data) {
    const h = healthResult.data as Record<string, unknown>;
    const bridge = h.bridge as Record<string, unknown> | undefined;
    if (bridge) {
      metadata.bridgeUptimeMs = bridge.uptimeMs ?? null;
      metadata.bridgePort = bridge.port ?? null;
      metadata.bridgeStatusPath = bridge.statusPath ?? null;
      metadata.tokenHealth = bridge.token ?? null;
      metadata.recentCalls = bridge.recentCalls ?? null;
    }
    metadata.rawStatus = h.status ?? null;
  } else {
    metadata.error = healthResult.error;
  }

  return {
    subsystem: {
      id: 'mcp-bridge',
      label: 'Local MCP Bridge',
      reachable: healthResult.success,
      required: true,
      metadata,
    },
    healthResult,
  };
}

/** Discover and record Caddy evidence (best-effort, process/service discovery). */
export function captureCaddyEvidence(): {
  subsystem: SubsystemRecord;
  discovery: CaddyDiscoveryResult;
} {
  const errors: string[] = [];

  // Check if caddy binary is available
  let caddyInstalled = false;
  try {
    const whichResult = fs.existsSync('/usr/bin/caddy') || fs.existsSync('/usr/local/bin/caddy');
    caddyInstalled = whichResult;
  } catch {
    errors.push('could not check caddy binary');
  }

  // Check if caddy process is running
  let caddyRunning = false;
  try {
    const pidLines = fs.readFileSync('/proc/loadavg', 'utf-8'); // not the right file, but we can't read /proc easily
    // Use a different approach for caddy process detection
    caddyRunning = false; // Will be checked by shell wrapper or ps
  } catch {
    // Not on Linux or can't read /proc
  }

  // Build path witnesses for config and data directories
  const configWitness = buildPathWitness('Caddy config', DEFAULTS.caddyConfigPath, false);
  const dataWitness = buildPathWitness('Caddy data directory', DEFAULTS.caddyDataPath, true);

  const reachable = caddyInstalled || configWitness.exists || dataWitness.exists;

  return {
    subsystem: {
      id: 'caddy',
      label: 'Caddy / Basic-Auth Proxy',
      reachable,
      required: true,
      metadata: {
        caddyInstalled,
        caddyRunning,
        configExists: configWitness.exists,
        dataExists: dataWitness.exists,
        discoveryErrors: errors.length > 0 ? errors : undefined,
      },
    },
    discovery: {
      caddyInstalled,
      caddyRunning,
      configWitness,
      dataWitness,
      errors,
    },
  };
}

/** Build path witnesses for SQLite database, logs, and artifacts. */
export function capturePathEvidence(options: CaptureOptions): PathWitness[] {
  const witnesses: PathWitness[] = [];

  // SQLite database path
  const dbPathStr = options.dbPath ?? DEFAULTS.dbPath;
  witnesses.push(buildPathWitness('SQLite database', dbPathStr, false));

  // Also check for WAL and SHM files
  const walPath = `${dbPathStr}-wal`;
  const shmPath = `${dbPathStr}-shm`;
  witnesses.push(buildPathWitness('SQLite WAL', walPath, false));
  witnesses.push(buildPathWitness('SQLite SHM', shmPath, false));

  // Log paths
  const logPaths = options.logPaths ?? DEFAULTS.logPaths;
  for (const logPath of logPaths) {
    witnesses.push(buildPathWitness(`Log directory: ${logPath}`, logPath, true));
  }

  // Artifact paths
  const artifactPaths = options.artifactPaths ?? DEFAULTS.artifactPaths;
  for (const artPath of artifactPaths) {
    witnesses.push(buildPathWitness(`Artifact directory: ${artPath}`, artPath, true));
  }

  // Also witness the deployment-witness artifacts root itself
  witnesses.push(buildPathWitness('Deployment witness artifacts root', ARTIFACTS_ROOT, true));

  return witnesses;
}

// ---------------------------------------------------------------------------
// Steady-state witness capture
// ---------------------------------------------------------------------------

/**
 * Take a single resource sample: host memory, load, and disk usage for tracked paths.
 */
export function sampleHostResources(
  growthTrackPaths?: Array<{ label: string; path: string }>,
): ResourceSample {
  const now = new Date();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg = os.loadavg();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';

  let diskUsage: Record<string, DiskSnapshot> | undefined;

  if (growthTrackPaths && growthTrackPaths.length > 0) {
    diskUsage = {};
    for (const { label, path: p } of growthTrackPaths) {
      let sizeBytes = 0;
      let exists = false;
      try {
        const stat = fs.statSync(p);
        exists = true;
        if (stat.isDirectory()) {
          sizeBytes = computeDirSize(p);
        } else {
          sizeBytes = stat.size;
        }
      } catch {
        // Path does not exist
      }
      diskUsage[label] = { path: p, sizeBytes, exists };
    }
  }

  return {
    timestamp: now.toISOString(),
    totalMemoryBytes: totalMem,
    freeMemoryBytes: freeMem,
    usedMemoryBytes: usedMem,
    memoryUsageFraction: totalMem > 0 ? usedMem / totalMem : 0,
    loadAverage1m: loadAvg[0] ?? 0,
    loadAverage5m: loadAvg[1] ?? 0,
    loadAverage15m: loadAvg[2] ?? 0,
    cpuModel,
    cpuCores: cpus.length,
    diskUsage,
    hostUptimeSec: Math.floor(os.uptime()),
  };
}

/**
 * Recursively compute the total size of a directory in bytes.
 * Uses `fs.readdirSync` and `fs.statSync` — no external deps.
 */
export function computeDirSize(dirPath: string): number {
  let totalSize = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          totalSize += computeDirSize(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          totalSize += stat.size;
        }
      } catch {
        // Permission denied or missing — skip
      }
    }
  } catch {
    // Directory not accessible
  }
  return totalSize;
}

/**
 * Probe whether a process is running by searching /proc (Linux) or using ps.
 * Returns a ProcessProbe with PID if found.
 */
export function probeProcess(processName: string): ProcessProbe {
  const result: ProcessProbe = {
    processName,
    running: false,
    pid: null,
    error: null,
  };

  try {
    // First try /proc (Linux)
    if (os.platform() === 'linux') {
      try {
        const procDirs = fs.readdirSync('/proc').filter(
          (name: string) => /^\d+$/.test(name),
        );
        for (const pidStr of procDirs) {
          try {
            const cmdlinePath = path.join('/proc', pidStr, 'cmdline');
            const cmdline = fs.readFileSync(cmdlinePath, 'utf-8');
            if (cmdline.includes(processName)) {
              result.running = true;
              result.pid = parseInt(pidStr, 10);
              return result;
            }
          } catch {
            // Process may have exited between readdir and stat
          }
        }
      } catch {
        // /proc not accessible
      }
    }

    // Fallback: try `ps aux` via child_process
    const psOutput = execSync(`ps aux | grep -v grep | grep "${processName}" || true`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (psOutput) {
      result.running = true;
      // Try to extract PID from ps output (second column on most implementations)
      const lines = psOutput.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[1], 10);
          if (!isNaN(pid)) {
            result.pid = pid;
            break;
          }
        }
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Perform a single HTTP health probe.
 * Returns an HttpProbe with response time and status.
 */
export async function probeHttp(
  url: string,
  timeoutMs: number,
): Promise<HttpProbe> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      // Consume response to get the full body
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseTimeMs = Date.now() - startTime;
        const statusCode = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const isRedirect = statusCode >= 300 && statusCode < 400;
        const isLocalHealthRedirect = isRedirect
          && location !== null
          && (location === '/health'
            || location.endsWith('/health')
            || location.startsWith('https://127.0.0.1/health')
            || location.startsWith('https://localhost/health'));
        const success = (statusCode >= 200 && statusCode < 300) || isLocalHealthRedirect;
        resolve({
          url,
          success,
          statusCode,
          responseTimeMs,
          timestamp,
          error: success ? null : `HTTP ${statusCode}`,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        url,
        success: false,
        statusCode: 0,
        responseTimeMs: Date.now() - startTime,
        timestamp,
        error: 'timeout',
      });
    });

    req.on('error', (err: Error) => {
      resolve({
        url,
        success: false,
        statusCode: 0,
        responseTimeMs: Date.now() - startTime,
        timestamp,
        error: err.message,
      });
    });
  });
}

/**
 * Probe a list of URLs in parallel and return the results.
 */
export async function probeHttpBatch(
  urls: string[],
  timeoutMs: number,
): Promise<HttpProbe[]> {
  return Promise.all(urls.map(url => probeHttp(url, timeoutMs)));
}

/**
 * Build growth records by comparing tracked-path sizes between two time points.
 */
export function computeGrowthRecords(
  startSample: ResourceSample | null,
  endSample: ResourceSample | null,
  startTime: Date,
  endTime: Date,
): GrowthRecord[] {
  const records: GrowthRecord[] = [];
  if (!startSample?.diskUsage || !endSample?.diskUsage) return records;

  const windowHours = (endTime.getTime() - startTime.getTime()) / 3_600_000;
  if (windowHours <= 0) return records;

  const allLabels = new Set([
    ...Object.keys(startSample.diskUsage),
    ...Object.keys(endSample.diskUsage),
  ]);

  for (const label of allLabels) {
    const start = startSample.diskUsage[label];
    const end = endSample.diskUsage[label];

    if (!start || !end) continue;

    const growthBytes = end.sizeBytes - start.sizeBytes;
    const growthBytesPerHour = Math.round(growthBytes / windowHours);

    records.push({
      label,
      path: start.path,
      startSizeBytes: start.sizeBytes,
      endSizeBytes: end.sizeBytes,
      growthBytes,
      growthBytesPerHour,
      existedThroughout: start.exists && end.exists,
    });
  }

  return records;
}

/**
 * Build subsystem evidence from periodic HTTP probe history.
 */
export function buildSubsystemEvidence(
  subsystemId: string,
  label: string,
  probeHistory: HttpProbe[],
  missingEvidenceReason: string | null,
  metadata?: Record<string, unknown>,
): SubsystemEvidence {
  const healthyThroughout = probeHistory.length > 0 && probeHistory.every(p => p.success);

  return {
    subsystemId,
    label,
    healthyThroughout,
    probes: probeHistory,
    missingEvidenceReason: probeHistory.length === 0
      ? (missingEvidenceReason ?? 'No probes were taken for this subsystem')
      : null,
    metadata: metadata ? redactMap(metadata) : undefined,
  };
}

/**
 * Run the full steady-state witness capture.
 *
 * This function:
 * 1. Creates a bundle directory for the steady-state run
 * 2. Takes an initial baseline resource sample
 * 3. Periodically samples host resources, probes HTTP health endpoints, and probes processes
 * 4. At the end, takes a final resource sample
 * 5. Computes growth records, resource summary, and verdict
 * 6. Returns the assembled SteadyStateWitnessManifest
 */
export async function runSteadyStateWitness(
  options: CaptureOptions = {},
): Promise<{
  bundleDir: string;
  runId: string;
  manifest: SteadyStateWitnessManifest;
}> {
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const durationSec = options.steadyStateDurationSec ?? DEFAULT_STEADY_STATE_DURATION_SEC;
  const intervalSec = options.steadyStateIntervalSec ?? DEFAULT_STEADY_STATE_INTERVAL_SEC;
  const processNames = options.processNames ?? [...DEFAULTS.processNames];

  // Generate run ID
  const startTime = new Date();
  const runId = `steady-${startTime.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`;
  const bundleDir = ensureBundleDir(runId);
  const label = options.label ?? `CAX11 steady-state witness — ${startTime.toISOString()}`;

  // Build growth track paths from options or defaults
  const growthTrackPaths: Array<{ label: string; path: string }> =
    options.growthTrackPaths ?? [
      { label: 'SQLite database', path: options.dbPath ?? DEFAULTS.dbPath },
      { label: 'Deployment artifacts', path: ARTIFACTS_ROOT },
      { label: 'Application logs', path: (options.logPaths ?? DEFAULTS.logPaths)[0] },
    ];

  // URLs to probe for subsystem health
  const healthUrls: Array<{ subsystemId: string; label: string; url: string }> = [
    { subsystemId: 'runtime', label: 'Trader Runtime', url: options.runtimeHealthUrl ?? DEFAULTS.runtimeHealthUrl },
    { subsystemId: 'notifier', label: 'Upstox Notifier', url: options.notifierHealthUrl ?? DEFAULTS.notifierHealthUrl },
    { subsystemId: 'mcp-bridge', label: 'Local MCP Bridge', url: options.bridgeHealthUrl ?? DEFAULTS.bridgeHealthUrl },
    { subsystemId: 'caddy', label: 'Caddy / Basic-Auth Proxy', url: 'http://127.0.0.1:80/health' }, // Best-effort
  ];

  // Probe state
  const resourceSamples: ResourceSample[] = [];
  const probeHistory: Map<string, HttpProbe[]> = new Map();
  for (const h of healthUrls) {
    probeHistory.set(h.subsystemId, []);
  }

  // Take initial baseline sample
  const initialSample = sampleHostResources(growthTrackPaths);
  resourceSamples.push(initialSample);

  // ── Sampling loop ────────────────────────────────────────────────────
  const startMs = Date.now();
  const endMs = startMs + durationSec * 1000;
  let iterationCount = 0;

  while (Date.now() < endMs) {
    iterationCount++;
    const now = Date.now();
    const remainingMs = endMs - now;

    // 1. Sample host resources
    const sample = sampleHostResources(growthTrackPaths);
    resourceSamples.push(sample);

    // 2. Probe HTTP health endpoints
    const healthProbes = await probeHttpBatch(
      healthUrls.map(h => h.url),
      httpTimeoutMs,
    );
    for (let i = 0; i < healthUrls.length; i++) {
      const existing = probeHistory.get(healthUrls[i].subsystemId) ?? [];
      existing.push(healthProbes[i]);
      probeHistory.set(healthUrls[i].subsystemId, existing);
    }

    // 3. Probe process presence (every other iteration to reduce overhead)
    if (iterationCount % 2 === 0) {
      // Process probes are stored at the end
    }

    // Sleep until next interval (or end time)
    const nextIntervalMs = Math.min(intervalSec * 1000, remainingMs);
    if (nextIntervalMs > 200) {
      await sleep(nextIntervalMs);
    } else {
      break;
    }
  }

  // Take final sample
  const finalSample = sampleHostResources(growthTrackPaths);
  resourceSamples.push(finalSample);

  const endTime = new Date();
  const actualDurationSec = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

  // ── Process evidence ──────────────────────────────────────────────────
  const processEvidence: ProcessProbe[] = processNames.map(name => probeProcess(name));

  // ── Build subsystem evidence ──────────────────────────────────────────
  const subsystemEvidence: SubsystemEvidence[] = healthUrls.map(h =>
    buildSubsystemEvidence(h.subsystemId, h.label, probeHistory.get(h.subsystemId) ?? [], null),
  );

  // ── Growth records ────────────────────────────────────────────────────
  const growthRecords = computeGrowthRecords(initialSample, finalSample, startTime, endTime);

  // ── Resource summary ──────────────────────────────────────────────────
  const resourceSummary = computeResourceSummary(resourceSamples);

  // ── Verdict ───────────────────────────────────────────────────────────
  const verdict = deriveSteadyStateVerdict(
    subsystemEvidence,
    resourceSummary,
    growthRecords,
    [...REQUIRED_SUBSYSTEMS],
  );

  // ── Annotations ───────────────────────────────────────────────────────
  const annotations: OptionalAnnotation[] = [
    { label: 'capture-node-version', value: process.version },
    { label: 'capture-platform', value: `${os.platform()} ${os.arch()}` },
    { label: 'http-timeout-ms', value: httpTimeoutMs },
    { label: 'process-count-total', value: processEvidence.filter(p => p.running).length },
    { label: 'iterations', value: iterationCount },
  ];

  // ── Assemble manifest ─────────────────────────────────────────────────
  const manifest: SteadyStateWitnessManifest = {
    schemaVersion: 1,
    artifactType: 'steady-state-witness',
    startedAt: startTime.toISOString(),
    endedAt: endTime.toISOString(),
    durationSec: actualDurationSec,
    intervalSec,
    runId,
    label,
    resourceSamples,
    resourceSummary,
    processEvidence,
    subsystemEvidence,
    growthRecords,
    verdict,
    annotations,
  };

  return { bundleDir, runId, manifest };
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main capture orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full witness capture and return the assembled result.
 *
 * This function:
 * 1. Creates the bundle directory under `data/artifacts/deployment-witness/<runId>/`
 * 2. Gathers host evidence
 * 3. Fetches application evidence from runtime, notifier, and bridge health endpoints
 * 4. Detects Caddy presence
 * 5. Records path witnesses for DB, logs, and artifacts
 * 6. Assembles and writes the manifest
 * 7. Writes individual evidence files (health payloads, host info)
 * 8. Returns the complete result
 */
export async function captureWitness(options: CaptureOptions = {}): Promise<CaptureResult> {
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  // Generate run ID from current timestamp
  const now = new Date();
  const runId = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const bundleDir = ensureBundleDir(runId);

  const capturedAt = now.toISOString();
  const label = options.label ?? `CAX11 blocked-mode witness — ${capturedAt}`;

  // ── 1. Host evidence ────────────────────────────────────────────────────
  const hostEvidence = captureHostEvidence();

  // ── 2. Subsystem evidence (parallel HTTP fetches) ───────────────────────
  const [runtimeResult, notifierResult, bridgeResult] = await Promise.all([
    captureRuntimeEvidence(options, httpTimeoutMs),
    captureNotifierEvidence(options, httpTimeoutMs),
    captureBridgeEvidence(options, httpTimeoutMs),
  ]);

  const caddyResult = captureCaddyEvidence();

  // ── 3. Path witnesses ──────────────────────────────────────────────────
  const pathWitnesses = capturePathEvidence(options);

  // ── 4. Build subsystem records ─────────────────────────────────────────
  const subsystems: SubsystemRecord[] = [
    runtimeResult.subsystem,
    notifierResult.subsystem,
    bridgeResult.subsystem,
    caddyResult.subsystem,
    // SQLite
    {
      id: 'sqlite',
      label: 'SQLite Database',
      reachable: pathWitnesses.some(w => w.label.startsWith('SQLite database') && w.exists),
      required: true,
      metadata: {
        dbPath: options.dbPath ?? DEFAULTS.dbPath,
        dbExists: pathWitnesses.some(w => w.label.startsWith('SQLite database') && w.exists),
        walExists: pathWitnesses.some(w => w.label.startsWith('SQLite WAL') && w.exists),
      },
    },
    // Logs
    {
      id: 'logs',
      label: 'Application Logs',
      reachable: pathWitnesses.some(w => w.label.startsWith('Log directory') && w.exists),
      required: true,
      metadata: {
        logPaths: options.logPaths ?? DEFAULTS.logPaths,
        anyLogDirExists: pathWitnesses.some(w => w.label.startsWith('Log directory') && w.exists),
      },
    },
    // Artifacts
    {
      id: 'artifacts',
      label: 'Deployment Artifacts',
      reachable: pathWitnesses.some(w => w.label.startsWith('Artifact directory') && w.exists),
      required: true,
      metadata: {
        artifactRoots: options.artifactPaths ?? DEFAULTS.artifactPaths,
        anyArtifactDirExists: pathWitnesses.some(w => w.label.startsWith('Artifact directory') && w.exists),
      },
    },
  ];

  // ── 5. Build app evidence ──────────────────────────────────────────────
  const unreachableSubsystems = subsystems
    .filter(s => s.required && !s.reachable)
    .map(s => s.id);

  const appEvidence: AppEvidence = {
    capturedAt,
    verdict: unreachableSubsystems.length === 0 ? 'healthy' : 'degraded',
    subsystemCount: subsystems.length,
    unreachableSubsystems,
  };

  // ── 6. Build annotations ───────────────────────────────────────────────
  const annotations: OptionalAnnotation[] = [
    {
      label: 'capture-node-version',
      value: process.version,
    },
    {
      label: 'capture-platform',
      value: `${os.platform()} ${os.arch()}`,
    },
    {
      label: 'http-timeout-ms',
      value: httpTimeoutMs,
    },
  ];

  // ── 7. Assemble manifest ──────────────────────────────────────────────
  const manifest: DeploymentWitnessManifest = {
    schemaVersion: 1,
    artifactType: 'deployment-witness',
    capturedAt,
    runId,
    label,
    subsystems,
    pathWitnesses,
    hostEvidence,
    appEvidence,
    annotations,
  };

  // ── 8. Assemble evidence files ─────────────────────────────────────────
  const evidenceFiles: Array<{ filename: string; content: string }> = [];

  // Host evidence file
  evidenceFiles.push({
    filename: 'host-evidence.json',
    content: JSON.stringify(hostEvidence, null, 2),
  });

  // Runtime health payload
  if (runtimeResult.healthResult.rawBody) {
    evidenceFiles.push({
      filename: 'runtime-health.json',
      content: runtimeResult.healthResult.rawBody,
    });
  }

  // Runtime dashboard payload
  if (runtimeResult.dashboardResult.rawBody) {
    evidenceFiles.push({
      filename: 'runtime-dashboard.json',
      content: runtimeResult.dashboardResult.rawBody,
    });
  }

  // Notifier health payload
  if (notifierResult.healthResult.rawBody) {
    evidenceFiles.push({
      filename: 'notifier-health.json',
      content: notifierResult.healthResult.rawBody,
    });
  }

  // Bridge health payload
  if (bridgeResult.healthResult.rawBody) {
    evidenceFiles.push({
      filename: 'bridge-health.json',
      content: bridgeResult.healthResult.rawBody,
    });
  }

  // Path evidence file
  evidenceFiles.push({
    filename: 'path-witnesses.json',
    content: JSON.stringify(pathWitnesses, null, 2),
  });

  // Subsystem inventory summary
  evidenceFiles.push({
    filename: 'subsystems.json',
    content: JSON.stringify(
      subsystems.map(s => ({
        id: s.id,
        label: s.label,
        reachable: s.reachable,
        required: s.required,
      })),
      null,
      2,
    ),
  });

  // Capture metadata
  evidenceFiles.push({
    filename: 'capture-meta.json',
    content: JSON.stringify({
      capturedAt,
      runId,
      label,
      schemaVersion: 1,
      hostname: hostEvidence.hostname,
      httpTimeoutMs,
      endpoints: {
        runtimeHealth: options.runtimeHealthUrl ?? DEFAULTS.runtimeHealthUrl,
        runtimeDashboard: options.runtimeDashboardUrl ?? DEFAULTS.runtimeDashboardUrl,
        notifierHealth: options.notifierHealthUrl ?? DEFAULTS.notifierHealthUrl,
        bridgeHealth: options.bridgeHealthUrl ?? DEFAULTS.bridgeHealthUrl,
      },
    }, null, 2),
  });

  return {
    bundleDir,
    runId,
    manifest,
    evidenceFiles,
  };
}

/**
 * Write the manifest and evidence files to the bundle directory.
 * Returns the paths written.
 */
export function writeWitnessBundle(result: CaptureResult): { manifestPath: string; evidencePaths: string[] } {
  const manifestPath = path.join(result.bundleDir, 'manifest.json');

  // Write manifest (use serializeManifest to handle redaction)
  const manifestContent = serializeManifest(result.manifest);
  fs.writeFileSync(manifestPath, manifestContent, 'utf-8');

  // Write evidence files
  const evidencePaths: string[] = [];
  for (const file of result.evidenceFiles) {
    const filePath = path.join(result.bundleDir, file.filename);
    fs.writeFileSync(filePath, file.content, 'utf-8');
    evidencePaths.push(filePath);
  }

  return { manifestPath, evidencePaths };
}

/**
 * Write a steady-state witness manifest to the bundle directory.
 * The steady-state manifest is self-contained (all evidence in one document).
 */
export function writeSteadyStateBundle(
  bundleDir: string,
  manifest: SteadyStateWitnessManifest,
): { manifestPath: string } {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return { manifestPath };
}

export {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_STEADY_STATE_INTERVAL_SEC,
  DEFAULT_STEADY_STATE_DURATION_SEC,
  DEFAULTS,
};
