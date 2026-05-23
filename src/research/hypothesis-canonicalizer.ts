import { createHash } from 'node:crypto';

import type { HypothesisCanonicalRecord, HypothesisGraph } from '../types/runtime.js';

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

/**
 * Normalize arbitrary JSON-like data into a deterministic structure:
 * - object keys sorted lexicographically
 * - arrays preserved in-order
 * - undefined object values omitted (matching JSON.stringify semantics)
 */
function normalizeJsonValue(value: unknown): CanonicalJsonValue | undefined {
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return value;
    case 'object': {
      if (Array.isArray(value)) {
        return value.map(item => {
          const normalized = normalizeJsonValue(item);
          return normalized === undefined ? null : normalized;
        });
      }

      const out: Record<string, CanonicalJsonValue> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const normalized = normalizeJsonValue((value as Record<string, unknown>)[key]);
        if (normalized !== undefined) {
          out[key] = normalized;
        }
      }
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * Produce a deterministic canonical JSON snapshot and stable SHA-256 digest
 * for a structured hypothesis graph.
 */
export function canonicalizeHypothesis(
  graph: HypothesisGraph,
): HypothesisCanonicalRecord {
  const normalized = normalizeJsonValue(graph) ?? null;
  const canonicalJson = JSON.stringify(normalized);
  const canonicalHash = createHash('sha256').update(canonicalJson).digest('hex');

  return {
    canonicalHash,
    canonicalJson,
  };
}
