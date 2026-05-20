// ── Operator UI render utilities ──
// Shared HTML rendering helpers for the operator dashboard pages.
// All user-supplied text is HTML-escaped before interpolation.
// Zero external dependencies — uses Node built-ins only.

import type { OperatorProvenance } from '../types/runtime.js';

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/**
 * HTML-entity escape a string for safe interpolation into HTML content.
 * Handles &, <, >, ", and '.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a number as currency (INR).
 */
export function formatCurrency(value: number, unit: string | null = 'INR'): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const formatted = abs.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return unit ? `${sign}₹${formatted}` : `${sign}${formatted}`;
}

/**
 * Format a number as a percentage (0-1 → "XX.X%").
 */
export function formatPercent(value: number | null, decimals = 1): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format a raw percentage value (e.g. 12.5 → "12.5%").
 */
export function formatRawPercent(value: number | null, decimals = 1): string {
  if (value === null) return '—';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format a number with tabular-nums-friendly formatting.
 */
export function formatNumber(value: number, decimals = 2): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format an integer.
 */
export function formatInt(value: number): string {
  return Math.round(value).toLocaleString('en-IN');
}

/**
 * Format staleness duration (ms) to a human-readable string.
 */
export function formatStaleness(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * ISO timestamp to compact display (e.g. "2025-01-15 14:30:05").
 */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/\.\d{3}\+.*$/, '').substring(0, 19);
}

/**
 * Truncate text in the middle, keeping head and tail visible.
 */
export function truncateMid(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor((maxLen - 3) / 2);
  return text.slice(0, half) + '...' + text.slice(text.length - half);
}

// ---------------------------------------------------------------------------
// Verdict/status color helpers
// ---------------------------------------------------------------------------

/** Get CSS color for a verdict or state string. */
export function verdictColor(verdict: string): string {
  switch (verdict) {
    case 'healthy':
    case 'approved':
    case 'accepted':
    case 'promote':
    case 'sufficient':
    case 'ok':
      return '#22c55e';
    case 'degraded':
    case 'refused':
    case 'demote':
    case 'stale':
    case 'warning':
      return '#f59e0b';
    case 'unhealthy':
    case 'error':
    case 'critical':
      return '#ef4444';
    case 'backtest':
      return '#94a3b8';
    case 'paper':
      return '#f59e0b';
    case 'live':
      return '#22c55e';
    default:
      return '#6b7280';
  }
}

// ---------------------------------------------------------------------------
// Provenance label
// ---------------------------------------------------------------------------

/**
 * Render a compact provenance badge.
 */
export function renderProvenanceBadge(provenance: OperatorProvenance | null): string {
  if (!provenance) return '';
  const sourceColor = provenance.source === 'historical' ? '#6366f1'
    : provenance.source === 'runtime' ? '#22c55e'
    : '#f59e0b';
  return `<span class="provenance" style="background:${sourceColor}22;color:${sourceColor}" title="Source: ${escapeHtml(provenance.source)}${provenance.sourceLabel ? ` (${escapeHtml(provenance.sourceLabel)})` : ''} | As of: ${new Date(provenance.asOf).toISOString()}">${escapeHtml(provenance.source)}</span>`;
}

// ---------------------------------------------------------------------------
// Section state badges
// ---------------------------------------------------------------------------

/**
 * Render an error banner for a failed section.
 */
export function renderErrorBanner(message: string): string {
  return `<div class="section-error-banner">
    <span class="section-error-icon">⚠</span>
    <span class="section-error-text">${escapeHtml(message)}</span>
  </div>`;
}

/**
 * Render a stale-data banner.
 */
export function renderStaleBanner(stalenessMs: number): string {
  return `<div class="section-stale-banner">
    <span class="section-stale-icon">⟳</span>
    <span class="section-stale-text">Data may be stale (last refreshed ${formatStaleness(stalenessMs)} ago)</span>
  </div>`;
}

/**
 * Render an empty state placeholder.
 */
export function renderEmptyState(message: string): string {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

// ---------------------------------------------------------------------------
// Standard section wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap section content in a standard section container with state banners.
 *
 * @param title - Section heading text.
 * @param content - Inner HTML content (already escaped as needed).
 * @param state - Section state: 'ok' | 'error' | 'stale' | 'unavailable'.
 * @param errorMessage - Error message when state is 'error'.
 * @param stalenessMs - Staleness in ms when state is 'stale'.
 * @param subtitle - Optional subtitle shown next to the title.
 */
export function renderSection(
  title: string,
  content: string,
  state: 'ok' | 'error' | 'stale' | 'unavailable' = 'ok',
  errorMessage: string | null = null,
  stalenessMs: number | null = null,
  subtitle: string | null = null,
): string {
  const borderColor = state === 'error' ? '#ef4444'
    : state === 'stale' ? '#f59e0b'
    : state === 'unavailable' ? '#64748b'
    : '#334155';

  let banner = '';
  if (state === 'error' && errorMessage) {
    banner = renderErrorBanner(errorMessage);
  } else if (state === 'stale' && stalenessMs !== null) {
    banner = renderStaleBanner(stalenessMs);
  }

  const subtitleHtml = subtitle ? `<span class="section-subtitle">${escapeHtml(subtitle)}</span>` : '';

  return `<div class="section" style="border-left: 3px solid ${borderColor};">
    <h2>${escapeHtml(title)} ${subtitleHtml}</h2>
    ${banner}
    ${state === 'unavailable' ? renderEmptyState(errorMessage ?? 'Section data is not available.') : content}
  </div>`;
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

/**
 * Render an HTML table from column definitions and data rows.
 *
 * @param columns - Column definitions with key, label, and optional render/cellClass.
 * @param rows - Array of data objects.
 * @param emptyMessage - Message shown when rows is empty.
 * @returns HTML string for the table (or empty state).
 */
export function renderTable<T extends Record<string, unknown>>(
  columns: Array<{
    key: keyof T & string;
    label: string;
    render?: (value: T[keyof T & string], row: T) => string;
    cellClass?: string | ((value: T[keyof T & string], row: T) => string);
  }>,
  rows: T[],
  emptyMessage = 'No data available.',
): string {
  if (rows.length === 0) {
    return renderEmptyState(emptyMessage);
  }

  const thead = columns.map(col => `<th>${escapeHtml(col.label)}</th>`).join('');

  const tbody = rows.map(row => {
    const cells = columns.map(col => {
      const value = row[col.key];
      let cellContent: string;
      if (col.render) {
        cellContent = col.render(value, row);
      } else if (value === null || value === undefined) {
        cellContent = '—';
      } else if (typeof value === 'number') {
        cellContent = escapeHtml(formatNumber(value));
      } else {
        cellContent = escapeHtml(String(value));
      }

      let cls = '';
      if (col.cellClass) {
        cls = typeof col.cellClass === 'function'
          ? ` class="${col.cellClass(value, row)}"`
          : ` class="${col.cellClass}"`;
      }

      return `<td${cls}>${cellContent}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Status class helper (for CSS styling)
// ---------------------------------------------------------------------------

/**
 * Get a CSS class name for a status/verdict string.
 */
export function statusClass(status: string): string {
  const ok = ['approved', 'accepted', 'healthy', 'promote', 'sufficient', 'ok', 'filled', 'active', 'live'];
  const warn = ['refused', 'degraded', 'demote', 'stale', 'warning', 'pending', 'paper', 'backtest'];
  const err = ['unhealthy', 'error', 'critical', 'rejected', 'cancelled', 'failed'];
  const skip = ['skipped', 'hold', 'flat', 'unknown', 'none'];

  if (ok.includes(status)) return 'status-ok';
  if (warn.includes(status)) return 'status-warn';
  if (err.includes(status)) return 'status-err';
  if (skip.includes(status)) return 'status-skip';
  return 'status-default';
}

// ---------------------------------------------------------------------------
// Duration formatting (uptime-like)
// ---------------------------------------------------------------------------

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
}
