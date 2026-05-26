import { describe, expect, it } from 'vitest';
import { parseArgs, parseIndiaWallClock } from '../src/research/overnight-research-main.js';

describe('overnight-research-main CLI time parsing', () => {
  it('parses --now-ist as an Asia/Kolkata wall-clock timestamp', () => {
    const parsed = parseIndiaWallClock('2026-05-26T16:30:00');
    expect(parsed.toISOString()).toBe('2026-05-26T11:00:00.000Z');
  });

  it('accepts space-separated --now-ist input', () => {
    const parsed = parseIndiaWallClock('2026-05-26 09:15');
    expect(parsed.toISOString()).toBe('2026-05-26T03:45:00.000Z');
  });

  it('wires --now-ist through parseArgs', () => {
    const options = parseArgs(['--now-ist', '2026-05-26T16:30:00']);
    expect(options.now?.toISOString()).toBe('2026-05-26T11:00:00.000Z');
  });

  it('rejects malformed --now-ist values', () => {
    expect(() => parseIndiaWallClock('2026/05/26 16:30')).toThrow(/Invalid --now-ist value/);
  });
});
