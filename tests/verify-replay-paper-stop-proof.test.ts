import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function newestProofArtifact(): string | null {
  const dir = 'data/artifacts/replay-paper-proof';
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('replay-paper-proof-') && f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] ? `${dir}/${files[0].f}` : null;
}

describe('verify-replay-paper-stop-proof', () => {
  it('passes end to end and writes a passing artifact', () => {
    execFileSync('node', ['--import', 'tsx', 'src/deployment/verify-replay-paper-stop-proof.ts'], { stdio: 'pipe' });
    const artifact = newestProofArtifact();
    expect(artifact).toBeTruthy();
    const json = JSON.parse(fs.readFileSync(artifact!, 'utf-8'));
    expect(json.verdict).toBe('PASS');
    expect(json.failed).toBe(0);
    expect(json.evidence.attempts).toBe(2);
    expect(json.evidence.fills).toBe(2);
  });
});
