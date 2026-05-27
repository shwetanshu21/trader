import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOperatorUiRouteUrl,
  makeOperatorUiTempDir,
  resolveOperatorUiRolloutTarget,
  seedOperatorUiDatabase,
  startOperatorUiProcess,
  stopOperatorUiProcess,
  type StartedOperatorUIProcess,
} from '../src/deployment/operator-ui-proof-support.js';
import {
  parseRolloutProofArgs,
  runOperatorUiRolloutProof,
} from '../src/deployment/verify-m014-s04-operator-rollout.js';

const tempDirs: string[] = [];
const startedProcesses: StartedOperatorUIProcess[] = [];
const createdArtifacts: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = makeOperatorUiTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function startTrackedOperatorUiProcess(options: Parameters<typeof startOperatorUiProcess>[0]): Promise<StartedOperatorUIProcess> {
  const app = await startOperatorUiProcess(options);
  startedProcesses.push(app);
  return app;
}

afterEach(async () => {
  while (startedProcesses.length > 0) {
    const processInfo = startedProcesses.pop();
    if (processInfo) {
      await stopOperatorUiProcess(processInfo);
    }
  }

  while (createdArtifacts.length > 0) {
    const artifactDir = createdArtifacts.pop();
    if (artifactDir) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('verify-m014-s04-operator-rollout', () => {
  it('defaults to the mandatory host-local target when no base URL is supplied', () => {
    const options = parseRolloutProofArgs([], { OPERATOR_UI_PASSWORD: 'deploy-secret' });
    const target = resolveOperatorUiRolloutTarget(options.baseUrl);

    expect(options.username).toBe('operator');
    expect(target.verificationMode).toBe('host-local-default');
    expect(target.baseUrl).toBe('http://127.0.0.1:3100');
    expect(buildOperatorUiRouteUrl(target, '/api/health')).toBe('http://127.0.0.1:3100/api/health');
  });

  it('supports explicit proxied base URLs with a preserved route prefix', () => {
    const options = parseRolloutProofArgs([
      '--base-url=https://details.aeroinference.com/operator',
      '--password=deploy-secret',
    ]);
    const target = resolveOperatorUiRolloutTarget(options.baseUrl);

    expect(target.verificationMode).toBe('explicit-base-url');
    expect(target.routePrefix).toBe('/operator');
    expect(buildOperatorUiRouteUrl(target, '/decision?id=1')).toBe('https://details.aeroinference.com/operator/decision?id=1');
  });

  it('requires a password via CLI or env so auth truthfulness checks hit the real boundary', () => {
    expect(() => parseRolloutProofArgs([])).toThrow('password must be provided via --password or OPERATOR_UI_PASSWORD');
  });

  it('writes a durable healthy-path artifact that proves auth truthfulness and representative routes', async () => {
    const tmpDir = makeTempDir('operator-ui-rollout-proof-');
    const dbPath = path.join(tmpDir, 'operator-ui.db');
    const artifactRoot = path.join(tmpDir, 'artifacts');
    seedOperatorUiDatabase(dbPath);

    const app = await startTrackedOperatorUiProcess({
      dbPath,
      rateLimitMax: 50,
    });

    const result = await runOperatorUiRolloutProof({
      baseUrl: app.baseUrl,
      username: app.username,
      password: app.password,
      holdOpenMs: 0,
      artifactRoot,
    });
    createdArtifacts.push(artifactRoot);

    expect(fs.existsSync(result.artifactPath)).toBe(true);
    expect(result.artifact.verdict).toBe('PASS');
    expect(result.artifact.harness).toBe('M014/S04 operator rollout proof');
    expect(result.artifact.routeCoverageMode).toBe('healthy');
    expect(result.artifact.target.verificationMode).toBe('explicit-base-url');
    expect(result.artifact.target.baseUrl).toBe(app.baseUrl);
    expect(result.artifact.authTruthfulness.unauthenticatedStatus).toBe(401);
    expect(result.artifact.authTruthfulness.unauthenticatedRealm).toContain('Operator Console');
    expect(result.artifact.authTruthfulness.wrongCredentialsStatus).toBe(401);
    expect(result.artifact.authTruthfulness.wrongCredentialsMessage).toContain('attempt(s) remaining before lockout');
    expect(result.artifact.surfacesTested).toContain(`${app.baseUrl}/api/refresh`);
    expect(result.artifact.apiHealth.status).toBe(200);
    expect(result.artifact.apiHealth.dbConnected).toBe(true);
    expect(result.artifact.assertions.every(assertion => assertion.pass)).toBe(true);

    const json = JSON.parse(fs.readFileSync(result.artifactPath, 'utf8')) as typeof result.artifact;
    expect(json.verdict).toBe('PASS');
    expect(json.target.baseUrl).toBe(app.baseUrl);
    expect(json.authTruthfulness.wrongCredentialsMessage).toContain('attempt(s) remaining before lockout');
  });
});
