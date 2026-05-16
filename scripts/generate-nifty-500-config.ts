#!/usr/bin/env npx tsx
/**
 * generate-nifty-500-config.ts
 *
 * Fetches all NSE EQ instruments from the Upstox instrument master
 * and writes them to data/nifty-500.json as a bounded universe config.
 *
 * Usage: npx tsx scripts/generate-nifty-500-config.ts
 *
 * Environment:
 *   TRADER_UPSTOX_TOKEN_PATH (optional) — path to Upstox token JSON file
 *     Defaults to ./tmp/upstox/notifier/latest-token.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { UpstoxRestClient } from '../src/upstox/upstox-rest-client.js';

const OUTPUT_PATH = path.resolve('data/nifty-500.json');

async function main(): Promise<void> {
  console.log('[generate-nifty-500-config] Instantiating UpstoxRestClient...');
  const client = new UpstoxRestClient();

  console.log('[generate-nifty-500-config] Fetching NSE EQ instruments...');
  const records = await client.fetchInstruments({
    exchanges: ['NSE'],
    segments: ['EQ'],
    instrumentTypes: ['EQ'],
  });

  console.log(`[generate-nifty-500-config] Fetched ${records.length} NSE EQ instruments.`);

  // Ensure output directory exists
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write pretty-printed JSON
  const json = JSON.stringify(records, null, 2);
  fs.writeFileSync(OUTPUT_PATH, json, 'utf8');
  console.log(`[generate-nifty-500-config] Wrote ${OUTPUT_PATH} (${json.length} bytes).`);

  // Self-validate: read back and verify structure
  const written = fs.readFileSync(OUTPUT_PATH, 'utf8');
  const parsed = JSON.parse(written) as unknown[];
  console.log(`[generate-nifty-500-config] Verified: ${parsed.length} records in output file.`);

  // Spot-check required fields on first entry
  if (parsed.length > 0) {
    const first = parsed[0] as Record<string, unknown>;
    const required = ['instrument_key', 'trading_symbol', 'exchange', 'instrument_type', 'lot_size', 'tick_size'];
    const missing = required.filter(f => !(f in first));
    if (missing.length > 0) {
      console.error(`[generate-nifty-500-config] WARNING: First record missing fields: ${missing.join(', ')}`);
    } else {
      console.log('[generate-nifty-500-config] First record has all required fields ✓');
    }
  }

  console.log('[generate-nifty-500-config] Done.');
}

main().catch((err) => {
  console.error(`[generate-nifty-500-config] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
