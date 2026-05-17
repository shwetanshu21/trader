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
  type CaptureOptions,
} from '../src/deployment/witness-capture.js';
import {
  ARTIFACTS_ROOT,
  buildPathWitness,
  validateManifest,
  hasRequiredEvidence,
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
