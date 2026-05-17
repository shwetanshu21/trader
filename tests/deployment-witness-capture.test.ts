// ── Deployment Witness Capture tests ──
//
// Covers:
//   - Host evidence capture (os module values, redacted hostname)
//   - Health endpoint fetches (success, timeout, unreachable)
//   - Path witness discovery (existing, missing, with children)
//   - Full capture orchestration (parallel fetch, manifest assembly)
//   - Bundle writing (manifest + evidence files on disk)
//   - Failure modes (timeout, unreachable endpoint, invalid JSON)
//   - Error paths (network error, timeout, malformed response)
//   - Boundary conditions (empty path arrays, zero-byte files)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import {
  captureHostEvidence,
  captureRuntimeEvidence,
  captureNotifierEvidence,
  captureBridgeEvidence,
  captureCaddyEvidence,
  capturePathEvidence,
  captureWitness,
  writeWitnessBundle,
  sampleHostResources,
  probeProcess,
  probeHttp,
  probeHttpBatch,
  computeGrowthRecords,
  buildSubsystemEvidence,
  runSteadyStateWitness,
  type CaptureOptions,
} from '../src/deployment/witness-capture.js';
import {
  ARTIFACTS_ROOT,
  buildPathWitness,
  validateManifest,
  hasRequiredEvidence,
  validateSteadyStateManifest,
} from '../src/deployment/witness-contract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Start a minimal HTTP server that responds on specific paths.
 * Returns the server and its bound port.
 */
function startTestServer(
  responses: Array<{
    path: string;
    status: number;
    body: string;
    delayMs?: number;
  }>,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      for (const r of responses) {
        if (url.pathname === r.path) {
          if (r.delayMs) {
            setTimeout(() => {
              res.writeHead(r.status, { 'Content-Type': 'application/json' });
              res.end(r.body);
            }, r.delayMs);
            return;
          }
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(r.body);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve({ server, port: address.port });
      } else {
        reject(new Error('Could not determine bound port'));
      }
    });

    server.on('error', reject);
  });
}

/** Create a temp directory for test witnesses. */
const TEST_ARTIFACTS_ROOT = path.join(ARTIFACTS_ROOT, '__test_capture__');

beforeEach(() => {
  // Ensure the test root doesn't exist
  if (fs.existsSync(TEST_ARTIFACTS_ROOT)) {
    fs.rmSync(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
  }
});

afterEach(() => {
  if (fs.existsSync(TEST_ARTIFACTS_ROOT)) {
    fs.rmSync(TEST_ARTIFACTS_ROOT, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureHostEvidence', () => {
  it('returns host evidence with all required fields', () => {
    const evidence = captureHostEvidence();

    expect(evidence).toBeDefined();
    expect(evidence.hostname).toBeDefined();
    expect(typeof evidence.hostname).toBe('string');
    // Hostname should be redacted (not the raw hostname)
    expect(evidence.hostname.length).toBeGreaterThan(8);

    expect(evidence.platform).toBeDefined();
    expect(['darwin', 'linux', 'win32']).toContain(evidence.platform);

    expect(evidence.arch).toBeDefined();
    expect(['arm64', 'x64', 'ia32']).toContain(evidence.arch);

    expect(evidence.totalMemoryBytes).toBeGreaterThan(0);
    expect(evidence.freeMemoryBytes).toBeGreaterThan(0);
    expect(evidence.cpuCores).toBeGreaterThan(0);
    expect(evidence.cpuModel).toBeDefined();
    expect(typeof evidence.cpuModel).toBe('string');
    expect(evidence.hostUptimeSec).toBeGreaterThan(0);
  });

  it('produces consistent hostname redaction for same host', () => {
    const a = captureHostEvidence();
    const b = captureHostEvidence();
    expect(a.hostname).toBe(b.hostname);
  });
});

describe('capturePathEvidence', () => {
  it('returns path witnesses for DB, logs, and artifacts', () => {
    const witnesses = capturePathEvidence({});

    expect(Array.isArray(witnesses)).toBe(true);
    expect(witnesses.length).toBeGreaterThanOrEqual(4);

    // Should have SQLite database path witness
    const dbWitness = witnesses.find(w => w.label.startsWith('SQLite database'));
    expect(dbWitness).toBeDefined();
    expect(dbWitness!.path).toBeTruthy();

    // Should have log paths
    const logWitness = witnesses.find(w => w.label.startsWith('Log directory'));
    expect(logWitness).toBeDefined();

    // Should have artifact paths
    const artWitness = witnesses.find(w => w.label.startsWith('Artifact directory'));
    expect(artWitness).toBeDefined();
  });

  it('accepts custom dbPath override', () => {
    const customPath = '/tmp/test-custom-path.db';
    const witnesses = capturePathEvidence({ dbPath: customPath });
    const dbWitness = witnesses.find(w => w.label.startsWith('SQLite database'));
    expect(dbWitness).toBeDefined();
    expect(dbWitness!.path).toBe(customPath);
  });

  it('accepts custom log and artifact paths', () => {
    const witnesses = capturePathEvidence({
      logPaths: ['/tmp/test-logs'],
      artifactPaths: ['/tmp/test-artifacts'],
    });

    expect(witnesses.some(w => w.label.includes('/tmp/test-logs'))).toBe(true);
    expect(witnesses.some(w => w.label.includes('/tmp/test-artifacts'))).toBe(true);
  });

  it('reports non-existent paths with exists=false', () => {
    const witnesses = capturePathEvidence({
      dbPath: '/tmp/definitely-does-not-exist-12345/db.sqlite',
    });
    const dbWitness = witnesses.find(w => w.label.startsWith('SQLite database'));
    expect(dbWitness!.exists).toBe(false);
    expect(dbWitness!.sizeBytes).toBe(0);
  });
});

describe('captureCaddyEvidence', () => {
  it('returns caddy subsystem record with valid structure', () => {
    const result = captureCaddyEvidence();

    expect(result.subsystem).toBeDefined();
    expect(result.subsystem.id).toBe('caddy');
    expect(result.subsystem.required).toBe(true);

    // Caddy may or may not be installed in test env
    expect(typeof result.subsystem.reachable).toBe('boolean');

    expect(result.discovery).toBeDefined();
    expect(result.discovery.configWitness).toBeDefined();
    expect(result.discovery.dataWitness).toBeDefined();
    expect(Array.isArray(result.discovery.errors)).toBe(true);
  });
});

describe('captureRuntimeEvidence', () => {
  it('returns reachable=true and health data when server responds', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy', uptimeMs: 5000 }) },
      { path: '/dashboard.json', status: 200, body: JSON.stringify({ overall: 'healthy', strategyDecisionCount: 10 }) },
    ]);

    try {
      const result = await captureRuntimeEvidence(
        {
          runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
          runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        },
        5000,
      );

      expect(result.subsystem.reachable).toBe(true);
      expect(result.subsystem.id).toBe('runtime');
      expect(result.subsystem.required).toBe(true);
      expect(result.healthResult.success).toBe(true);
      expect(result.dashboardResult.success).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns reachable=false on connection refused', async () => {
    const result = await captureRuntimeEvidence(
      {
        runtimeHealthUrl: 'http://127.0.0.1:18999/nonexistent',
        runtimeDashboardUrl: 'http://127.0.0.1:18999/nonexistent',
      },
      1000,
    );

    expect(result.subsystem.reachable).toBe(false);
    expect(result.healthResult.success).toBe(false);
    expect(result.healthResult.error).toBeTruthy();
    expect(result.dashboardResult.success).toBe(false);
  });

  it('returns reachable=true if either endpoint responds', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy' }) },
    ]);

    try {
      const result = await captureRuntimeEvidence(
        {
          runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
          runtimeDashboardUrl: `http://127.0.0.1:${port}/nonexistent`,
        },
        1000,
      );

      expect(result.subsystem.reachable).toBe(true);
      expect(result.healthResult.success).toBe(true);
      expect(result.dashboardResult.success).toBe(false);
    } finally {
      server.close();
    }
  });

  it('handles malformed JSON responses gracefully', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: 'not-json-at-all' },
      { path: '/dashboard.json', status: 200, body: 'also-not-json' },
    ]);

    try {
      const result = await captureRuntimeEvidence(
        {
          runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
          runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        },
        1000,
      );

      // Should still report success (HTTP 200) but data will be null
      expect(result.subsystem.reachable).toBe(true);
      expect(result.healthResult.success).toBe(true);
      expect(result.healthResult.data).toBeNull();
    } finally {
      server.close();
    }
  });

  it('handles HTTP error status codes', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 500, body: JSON.stringify({ error: 'internal' }) },
      { path: '/dashboard.json', status: 503, body: JSON.stringify({ error: 'unavailable' }) },
    ]);

    try {
      const result = await captureRuntimeEvidence(
        {
          runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
          runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        },
        1000,
      );

      expect(result.subsystem.reachable).toBe(false);
      expect(result.healthResult.success).toBe(false);
      expect(result.dashboardResult.success).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('captureNotifierEvidence', () => {
  it('returns reachable=true when notifier responds', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ status: 'ok', uptimeMs: 1000, notifierPath: '/upstox/notifier' }) },
    ]);

    try {
      const result = await captureNotifierEvidence(
        { notifierHealthUrl: `http://127.0.0.1:${port}/health` },
        5000,
      );

      expect(result.subsystem.reachable).toBe(true);
      expect(result.subsystem.id).toBe('notifier');
      expect(result.subsystem.required).toBe(true);
      expect(result.healthResult.success).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns reachable=false on timeout', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: 'slow', delayMs: 5000 },
    ]);

    try {
      const result = await captureNotifierEvidence(
        { notifierHealthUrl: `http://127.0.0.1:${port}/health` },
        500,
      );

      expect(result.subsystem.reachable).toBe(false);
      expect(result.healthResult.error).toBe('timeout');
    } finally {
      server.close();
    }
  });
});

describe('captureBridgeEvidence', () => {
  it('returns reachable=true when bridge responds', async () => {
    const healthBody = JSON.stringify({
      status: 'ok',
      bridge: {
        uptimeMs: 2000,
        port: 8787,
        statusPath: '/tmp/status.json',
        token: { exists: true, isExpired: false },
      },
    });

    const { server, port } = await startTestServer([
      {
        path: '/health',
        status: 200,
        body: healthBody,
      },
    ]);

    try {
      const result = await captureBridgeEvidence(
        { bridgeHealthUrl: `http://127.0.0.1:${port}/health` },
        5000,
      );

      expect(result.subsystem.reachable).toBe(true);
      expect(result.subsystem.id).toBe('mcp-bridge');
      expect(result.subsystem.required).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns reachable=false on unreachable endpoint', async () => {
    const result = await captureBridgeEvidence(
      { bridgeHealthUrl: 'http://127.0.0.1:18998/nonexistent' },
      500,
    );

    expect(result.subsystem.reachable).toBe(false);
    expect(result.healthResult.success).toBe(false);
    expect(result.healthResult.error).toBeTruthy();
  });
});

describe('captureWitness (full orchestration)', () => {
  it('produces a complete manifest with all 7 subsystems', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy', uptimeMs: 5000 }) },
      { path: '/dashboard.json', status: 200, body: JSON.stringify({ overall: 'healthy', strategyDecisionCount: 42, executionMode: 'blocked' }) },
    ]);

    try {
      const options: CaptureOptions = {
        runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
        runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        notifierHealthUrl: `http://127.0.0.1:${port}/health`,
        bridgeHealthUrl: `http://127.0.0.1:${port}/health`,
        dbPath: '/tmp/nonexistent-test-db.sqlite',
        httpTimeoutMs: 5000,
        label: 'test-witness',
      };

      const result = await captureWitness(options);

      expect(result).toBeDefined();
      expect(result.runId).toBeTruthy();
      expect(result.bundleDir).toContain('deployment-witness');
      expect(result.manifest).toBeDefined();

      // Check all 7 required subsystems
      const subsystemIds = result.manifest.subsystems.map(s => s.id);
      expect(subsystemIds).toContain('runtime');
      expect(subsystemIds).toContain('notifier');
      expect(subsystemIds).toContain('mcp-bridge');
      expect(subsystemIds).toContain('caddy');
      expect(subsystemIds).toContain('sqlite');
      expect(subsystemIds).toContain('logs');
      expect(subsystemIds).toContain('artifacts');

      // Runtime, notifier, and bridge should be reachable (mock server responded)
      const runtime = result.manifest.subsystems.find(s => s.id === 'runtime')!;
      expect(runtime.reachable).toBe(true);

      const notifier = result.manifest.subsystems.find(s => s.id === 'notifier')!;
      expect(notifier.reachable).toBe(true);

      const bridge = result.manifest.subsystems.find(s => s.id === 'mcp-bridge')!;
      expect(bridge.reachable).toBe(true);

      // Host evidence should be populated
      expect(result.manifest.hostEvidence.totalMemoryBytes).toBeGreaterThan(0);
      expect(result.manifest.hostEvidence.cpuCores).toBeGreaterThan(0);

      // App evidence should reflect reachable status
      expect(result.manifest.appEvidence.verdict).toBeDefined();
      expect(result.manifest.appEvidence.subsystemCount).toBe(7);

      // Path witnesses should be present
      expect(result.manifest.pathWitnesses.length).toBeGreaterThan(0);

      // Annotations should be present
      expect(result.manifest.annotations.length).toBeGreaterThan(0);

      // Evidence files should be assembled
      expect(result.evidenceFiles.length).toBeGreaterThanOrEqual(6);

      // Should have host-evidence, runtime-health, runtime-dashboard, notifier-health,
      // bridge-health, path-witnesses, subsystems, capture-meta
      const filenames = result.evidenceFiles.map(f => f.filename);
      expect(filenames).toContain('host-evidence.json');
      expect(filenames).toContain('runtime-health.json');
      expect(filenames).toContain('runtime-dashboard.json');
      expect(filenames).toContain('notifier-health.json');
      expect(filenames).toContain('bridge-health.json');
      expect(filenames).toContain('path-witnesses.json');
      expect(filenames).toContain('subsystems.json');
      expect(filenames).toContain('capture-meta.json');
    } finally {
      server.close();
    }
  });

  it('produces degraded verdict when required subsystems unreachable', async () => {
    const options: CaptureOptions = {
      runtimeHealthUrl: 'http://127.0.0.1:18997/nonexistent',
      runtimeDashboardUrl: 'http://127.0.0.1:18997/nonexistent',
      notifierHealthUrl: 'http://127.0.0.1:18997/nonexistent',
      bridgeHealthUrl: 'http://127.0.0.1:18997/nonexistent',
      dbPath: '/tmp/nonexistent-test-db.sqlite',
      httpTimeoutMs: 500,
      label: 'degraded-test',
    };

    const result = await captureWitness(options);

    // App evidence verdict should be degraded
    expect(result.manifest.appEvidence.verdict).toBe('degraded');
    expect(result.manifest.appEvidence.unreachableSubsystems.length).toBeGreaterThan(0);

    // Should include runtime, notifier, mcp-bridge in unreachable
    const unreachable = result.manifest.appEvidence.unreachableSubsystems;
    expect(unreachable).toContain('runtime');
    expect(unreachable).toContain('notifier');
    expect(unreachable).toContain('mcp-bridge');
  });

  it('validates against the witness contract', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy' }) },
      { path: '/dashboard.json', status: 200, body: JSON.stringify({ overall: 'healthy' }) },
    ]);

    try {
      const options: CaptureOptions = {
        runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
        runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        notifierHealthUrl: `http://127.0.0.1:${port}/health`,
        bridgeHealthUrl: `http://127.0.0.1:${port}/health`,
        httpTimeoutMs: 5000,
      };

      const result = await captureWitness(options);

      // Validate manifest
      const violations = validateManifest(result.manifest);
      expect(violations).toEqual([]);

      // hasRequiredEvidence check may fail if caddy/sqlite/logs/artifacts are unreachable
      // but that's expected in test env — the contract still validates
    } finally {
      server.close();
    }
  });
});

describe('writeWitnessBundle', () => {
  it('writes manifest.json and evidence files to the bundle directory', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy' }) },
      { path: '/dashboard.json', status: 200, body: JSON.stringify({ overall: 'healthy' }) },
    ]);

    try {
      const options: CaptureOptions = {
        runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
        runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        notifierHealthUrl: `http://127.0.0.1:${port}/health`,
        bridgeHealthUrl: `http://127.0.0.1:${port}/health`,
        httpTimeoutMs: 5000,
      };

      const result = await captureWitness(options);
      const written = writeWitnessBundle(result);

      // Check manifest was written
      expect(fs.existsSync(written.manifestPath)).toBe(true);
      const manifestContent = fs.readFileSync(written.manifestPath, 'utf-8');
      const parsedManifest = JSON.parse(manifestContent);
      expect(parsedManifest.artifactType).toBe('deployment-witness');

      // Check evidence files were written
      expect(written.evidencePaths.length).toBeGreaterThan(0);
      for (const ep of written.evidencePaths) {
        expect(fs.existsSync(ep)).toBe(true);
        const content = fs.readFileSync(ep, 'utf-8');
        expect(content.length).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  });

  it('redacts secret-bearing fields in the written manifest', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy' }) },
      { path: '/dashboard.json', status: 200, body: JSON.stringify({ overall: 'healthy' }) },
    ]);

    try {
      const options: CaptureOptions = {
        runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
        runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        notifierHealthUrl: `http://127.0.0.1:${port}/health`,
        bridgeHealthUrl: `http://127.0.0.1:${port}/health`,
        httpTimeoutMs: 5000,
      };

      const result = await captureWitness(options);
      // Add a secret annotation
      result.manifest.annotations.push({
        label: 'test-secret',
        value: { access_token: 'should-be-redacted-secret', safe: 'keep' },
      });

      const written = writeWitnessBundle(result);
      const content = fs.readFileSync(written.manifestPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Hostname should be redacted
      expect(parsed.hostEvidence.hostname).not.toBe(result.manifest.hostEvidence.hostname);

      // Annotation secret value should be masked
      const secretAnnotation = parsed.annotations.find(
        (a: { label: string }) => a.label === 'test-secret',
      );
      expect(secretAnnotation).toBeDefined();
      expect(secretAnnotation.value.access_token).not.toBe('should-be-redacted-secret');
      expect(secretAnnotation.value.safe).toBe('keep');
    } finally {
      server.close();
    }
  });
});

describe('failure modes', () => {
  it('captureRuntimeEvidence handles malformed responses without crashing', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: '{broken json' },
      { path: '/dashboard.json', status: 200, body: '[not an object]' },
    ]);

    try {
      const result = await captureRuntimeEvidence(
        {
          runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
          runtimeDashboardUrl: `http://127.0.0.1:${port}/dashboard.json`,
        },
        1000,
      );

      // Should not throw — data field will be null for unparseable JSON
      expect(result.subsystem.reachable).toBe(true); // HTTP 200
      expect(result.healthResult.data).toBeNull();
      expect(result.healthResult.rawBody).toBe('{broken json');
    } finally {
      server.close();
    }
  });

  it('captureWitness handles all endpoints being unreachable', async () => {
    const options: CaptureOptions = {
      runtimeHealthUrl: 'http://127.0.0.1:18996/nonexistent',
      runtimeDashboardUrl: 'http://127.0.0.1:18996/nonexistent',
      notifierHealthUrl: 'http://127.0.0.1:18996/nonexistent',
      bridgeHealthUrl: 'http://127.0.0.1:18996/nonexistent',
      httpTimeoutMs: 500,
    };

    const result = await captureWitness(options);

    // Should still produce a result (no crash)
    expect(result.manifest).toBeDefined();
    expect(result.bundleDir).toBeTruthy();

    // Required subsystems should be unreachable
    const unreachable = result.manifest.subsystems.filter(s => s.required && !s.reachable);
    expect(unreachable.length).toBeGreaterThanOrEqual(3); // runtime, notifier, bridge
  });

  it('capturePathEvidence handles zero-byte files', () => {
    const tmpDir = fs.mkdtempSync('witness-test-');
    const zeroFile = path.join(tmpDir, 'zero.db');
    fs.writeFileSync(zeroFile, '', 'utf-8');

    const witnesses = capturePathEvidence({ dbPath: zeroFile });
    const dbWitness = witnesses.find(w => w.label.startsWith('SQLite database'));
    expect(dbWitness).toBeDefined();
    expect(dbWitness!.exists).toBe(true);
    expect(dbWitness!.sizeBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Steady-state witness tests
// ---------------------------------------------------------------------------

describe('sampleHostResources', () => {
  it('returns a resource sample with all required fields', () => {
    const sample = sampleHostResources();
    expect(sample).toBeDefined();
    expect(sample.timestamp).toBeDefined();
    expect(typeof sample.totalMemoryBytes).toBe('number');
    expect(sample.totalMemoryBytes).toBeGreaterThan(0);
    expect(typeof sample.freeMemoryBytes).toBe('number');
    expect(typeof sample.usedMemoryBytes).toBe('number');
    expect(typeof sample.memoryUsageFraction).toBe('number');
    expect(sample.memoryUsageFraction).toBeGreaterThan(0);
    expect(sample.memoryUsageFraction).toBeLessThanOrEqual(1);
    expect(typeof sample.loadAverage1m).toBe('number');
    expect(typeof sample.cpuModel).toBe('string');
    expect(sample.cpuCores).toBeGreaterThan(0);
    expect(sample.hostUptimeSec).toBeGreaterThan(0);
  });

  it('includes diskUsage when growthTrackPaths are provided', () => {
    const sample = sampleHostResources([
      { label: 'Test DB', path: '/tmp/nonexistent-test-path-12345.db' },
    ]);
    expect(sample.diskUsage).toBeDefined();
    expect(sample.diskUsage!['Test DB']).toBeDefined();
    expect(sample.diskUsage!['Test DB'].exists).toBe(false);
  });

  it('produces consistent usedMemoryBytes = total - free', () => {
    const sample = sampleHostResources();
    expect(sample.usedMemoryBytes).toBe(sample.totalMemoryBytes - sample.freeMemoryBytes);
  });

  it('diskUsage is undefined when no paths provided', () => {
    const sample = sampleHostResources();
    expect(sample.diskUsage).toBeUndefined();
  });
});

describe('probeProcess', () => {
  it('returns a ProcessProbe with all fields', () => {
    const result = probeProcess('this-process-definitely-does-not-exist-xyz');
    expect(result.processName).toBe('this-process-definitely-does-not-exist-xyz');
    expect(typeof result.running).toBe('boolean');
    expect(result.running).toBe(false);
    // pid should be null when not running
    expect(result.pid).toBeNull();
  });

  it('detects the current node process', () => {
    // 'node' should be running in the test environment
    const result = probeProcess('node');
    expect(result.running).toBe(true);
    expect(result.pid).toBeGreaterThan(0);
  });
});

describe('probeHttp', () => {
  it('returns success for a valid HTTP endpoint', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ ok: true }) },
    ]);

    try {
      const result = await probeHttp(`http://127.0.0.1:${port}/health`, 5000);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(result.error).toBeNull();
    } finally {
      server.close();
    }
  });

  it('returns failure for an unreachable endpoint', async () => {
    const result = await probeHttp('http://127.0.0.1:18995/nonexistent', 500);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.error).toBeTruthy();
  });

  it('returns failure for HTTP error status', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 500, body: 'Internal Server Error' },
    ]);

    try {
      const result = await probeHttp(`http://127.0.0.1:${port}/health`, 5000);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain('500');
    } finally {
      server.close();
    }
  });
});

describe('probeHttpBatch', () => {
  it('probes multiple URLs in parallel', async () => {
    const { server, port } = await startTestServer([
      { path: '/a', status: 200, body: 'ok' },
      { path: '/b', status: 200, body: 'ok' },
    ]);

    try {
      const results = await probeHttpBatch(
        [`http://127.0.0.1:${port}/a`, `http://127.0.0.1:${port}/b`],
        5000,
      );
      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    } finally {
      server.close();
    }
  });

  it('handles mixed success and failure', async () => {
    const { server, port } = await startTestServer([
      { path: '/ok', status: 200, body: 'ok' },
    ]);

    try {
      const results = await probeHttpBatch(
        [`http://127.0.0.1:${port}/ok`, 'http://127.0.0.1:18994/nonexistent'],
        500,
      );
      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('computeGrowthRecords', () => {
  it('returns empty array when no diskUsage data', () => {
    const start = new Date('2025-01-05T00:00:00.000Z');
    const end = new Date('2025-01-05T01:00:00.000Z');
    const records = computeGrowthRecords(null, null, start, end);
    expect(records).toEqual([]);
  });

  it('computes growth from start to end samples', () => {
    const startSample = {
      timestamp: '2025-01-05T00:00:00.000Z',
      totalMemoryBytes: 8_000_000_000,
      freeMemoryBytes: 4_000_000_000,
      usedMemoryBytes: 4_000_000_000,
      memoryUsageFraction: 0.5,
      loadAverage1m: 1.0,
      loadAverage5m: 0.8,
      loadAverage15m: 0.6,
      cpuModel: 'ARM',
      cpuCores: 4,
      hostUptimeSec: 3600,
      diskUsage: {
        'SQLite database': { path: './data/production.db', sizeBytes: 1_000_000, exists: true },
      },
    };
    const endSample = {
      ...startSample,
      timestamp: '2025-01-05T01:00:00.000Z',
      diskUsage: {
        'SQLite database': { path: './data/production.db', sizeBytes: 1_500_000, exists: true },
      },
    };
    const start = new Date('2025-01-05T00:00:00.000Z');
    const end = new Date('2025-01-05T01:00:00.000Z');

    const records = computeGrowthRecords(startSample, endSample, start, end);
    expect(records.length).toBe(1);
    expect(records[0].label).toBe('SQLite database');
    expect(records[0].growthBytes).toBe(500_000);
    expect(records[0].growthBytesPerHour).toBe(500_000);
    expect(records[0].existedThroughout).toBe(true);
  });

  it('returns empty array when window is zero', () => {
    const sample = {
      timestamp: '2025-01-05T00:00:00.000Z',
      totalMemoryBytes: 8_000_000_000,
      freeMemoryBytes: 4_000_000_000,
      usedMemoryBytes: 4_000_000_000,
      memoryUsageFraction: 0.5,
      loadAverage1m: 1.0,
      loadAverage5m: 0.8,
      loadAverage15m: 0.6,
      cpuModel: 'ARM',
      cpuCores: 4,
      hostUptimeSec: 3600,
      diskUsage: {
        'SQLite': { path: './data/production.db', sizeBytes: 1_000_000, exists: true },
      },
    };
    const now = new Date('2025-01-05T00:00:00.000Z');
    const records = computeGrowthRecords(sample, sample, now, now);
    expect(records).toEqual([]);
  });
});

describe('buildSubsystemEvidence', () => {
  it('returns healthy=true when all probes succeed', () => {
    const probes = [
      { url: 'http://localhost/health', success: true, statusCode: 200, responseTimeMs: 50, timestamp: '2025-01-05T00:00:00.000Z', error: null },
      { url: 'http://localhost/health', success: true, statusCode: 200, responseTimeMs: 45, timestamp: '2025-01-05T00:01:00.000Z', error: null },
    ];
    const evidence = buildSubsystemEvidence('runtime', 'Trader Runtime', probes, null);
    expect(evidence.healthyThroughout).toBe(true);
    expect(evidence.missingEvidenceReason).toBeNull();
    expect(evidence.probes.length).toBe(2);
  });

  it('returns healthy=false when any probe fails', () => {
    const probes = [
      { url: 'http://localhost/health', success: true, statusCode: 200, responseTimeMs: 50, timestamp: '2025-01-05T00:00:00.000Z', error: null },
      { url: 'http://localhost/health', success: false, statusCode: 503, responseTimeMs: 100, timestamp: '2025-01-05T00:01:00.000Z', error: 'HTTP 503' },
    ];
    const evidence = buildSubsystemEvidence('runtime', 'Trader Runtime', probes, null);
    expect(evidence.healthyThroughout).toBe(false);
  });

  it('sets missingEvidenceReason when no probes were taken', () => {
    const evidence = buildSubsystemEvidence('runtime', 'Trader Runtime', [], 'Endpoint unreachable from start');
    expect(evidence.healthyThroughout).toBe(false);
    expect(evidence.missingEvidenceReason).toBe('Endpoint unreachable from start');
  });

  it('sets default missingEvidenceReason when none provided and no probes', () => {
    const evidence = buildSubsystemEvidence('runtime', 'Trader Runtime', [], null);
    expect(evidence.missingEvidenceReason).toContain('No probes were taken');
  });
});

describe('runSteadyStateWitness', () => {
  const TEST_SS_ROOT = path.join(ARTIFACTS_ROOT, '__test_steady_state__');

  beforeEach(() => {
    if (fs.existsSync(TEST_SS_ROOT)) {
      fs.rmSync(TEST_SS_ROOT, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_SS_ROOT)) {
      fs.rmSync(TEST_SS_ROOT, { recursive: true, force: true });
    }
  });

  it('produces a complete steady-state manifest with all required fields', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy' }) },
    ]);

    try {
      const result = await runSteadyStateWitness({
        runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
        runtimeDashboardUrl: `http://127.0.0.1:${port}/health`,
        notifierHealthUrl: `http://127.0.0.1:${port}/health`,
        bridgeHealthUrl: `http://127.0.0.1:${port}/health`,
        steadyStateDurationSec: 2, // Short duration for tests
        steadyStateIntervalSec: 1,
        httpTimeoutMs: 2000,
        label: 'test-steady-state',
        processNames: ['node'],
      });

      expect(result).toBeDefined();
      expect(result.runId).toContain('steady-');
      expect(result.bundleDir).toContain('deployment-witness');

      const m = result.manifest;
      expect(m.artifactType).toBe('steady-state-witness');
      expect(m.schemaVersion).toBe(1);
      expect(m.startedAt).toBeDefined();
      expect(m.endedAt).toBeDefined();
      expect(m.durationSec).toBeGreaterThan(0);
      expect(m.intervalSec).toBe(1);
      expect(m.runId).toBeTruthy();

      // Resource samples
      expect(Array.isArray(m.resourceSamples)).toBe(true);
      expect(m.resourceSamples.length).toBeGreaterThanOrEqual(2);

      // Resource summary
      expect(m.resourceSummary.sampleCount).toBeGreaterThanOrEqual(2);
      expect(m.resourceSummary.memory.avgUsedBytes).toBeGreaterThan(0);

      // Process evidence
      expect(Array.isArray(m.processEvidence)).toBe(true);
      const nodeProbe = m.processEvidence.find(p => p.processName === 'node');
      expect(nodeProbe).toBeDefined();
      expect(nodeProbe!.running).toBe(true);

      // Subsystem evidence
      expect(Array.isArray(m.subsystemEvidence)).toBe(true);
      expect(m.subsystemEvidence.length).toBeGreaterThanOrEqual(3);
      const runtime = m.subsystemEvidence.find(s => s.subsystemId === 'runtime');
      expect(runtime).toBeDefined();
      expect(runtime!.healthyThroughout).toBe(true);

      // Growth records
      expect(Array.isArray(m.growthRecords)).toBe(true);

      // Verdict
      expect(m.verdict).toBeDefined();
      expect(['pass', 'caveat', 'fail']).toContain(m.verdict.verdict);
      expect(m.verdict.summary).toBeTruthy();
      expect(Array.isArray(m.verdict.concerns)).toBe(true);

      // Annotations
      expect(Array.isArray(m.annotations)).toBe(true);

      // Validate against contract
      const violations = validateSteadyStateManifest(m);
      expect(violations).toEqual([]);
    } finally {
      server.close();
    }
  }, 30_000);

  it('degrades verdict when endpoints are unreachable', async () => {
    const result = await runSteadyStateWitness({
      runtimeHealthUrl: 'http://127.0.0.1:18993/nonexistent',
      runtimeDashboardUrl: 'http://127.0.0.1:18993/nonexistent',
      notifierHealthUrl: 'http://127.0.0.1:18993/nonexistent',
      bridgeHealthUrl: 'http://127.0.0.1:18993/nonexistent',
      steadyStateDurationSec: 2,
      steadyStateIntervalSec: 1,
      httpTimeoutMs: 500,
      label: 'test-degraded',
      processNames: ['node'],
    });

    const m = result.manifest;
    // Probes were attempted but all failed — should be caveat, not fail
    // (fail is reserved for subsystems with zero probes / missing evidence)
    expect(m.verdict.verdict).toBe('caveat');
    expect(m.verdict.degradedRequiredCount).toBeGreaterThan(0);

    // Subsystem evidence should reflect failures
    const runtimeEvidence = m.subsystemEvidence.find(s => s.subsystemId === 'runtime');
    expect(runtimeEvidence).toBeDefined();
    expect(runtimeEvidence!.healthyThroughout).toBe(false);
    expect(runtimeEvidence!.probes.length).toBeGreaterThanOrEqual(1);
    expect(runtimeEvidence!.probes.every(p => p.success)).toBe(false);
  }, 30_000);

  it('generates process evidence for running node process', async () => {
    const { server, port } = await startTestServer([
      { path: '/health', status: 200, body: JSON.stringify({ verdict: 'healthy' }) },
    ]);

    try {
      const result = await runSteadyStateWitness({
        runtimeHealthUrl: `http://127.0.0.1:${port}/health`,
        runtimeDashboardUrl: `http://127.0.0.1:${port}/health`,
        notifierHealthUrl: `http://127.0.0.1:${port}/health`,
        bridgeHealthUrl: `http://127.0.0.1:${port}/health`,
        steadyStateDurationSec: 1,
        steadyStateIntervalSec: 1,
        httpTimeoutMs: 2000,
        processNames: ['node', 'this-process-does-not-exist'],
      });

      const nodeProbe = result.manifest.processEvidence.find(p => p.processName === 'node');
      expect(nodeProbe).toBeDefined();
      expect(nodeProbe!.running).toBe(true);

      const missingProbe = result.manifest.processEvidence.find(
        p => p.processName === 'this-process-does-not-exist',
      );
      expect(missingProbe).toBeDefined();
      expect(missingProbe!.running).toBe(false);
    } finally {
      server.close();
    }
  }, 30_000);
});
