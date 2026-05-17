const DAY_MS = 86_400_000;
const MAX_UPSTOX_1MINUTE_CHUNK_DAYS = 28;

export interface HistoricalDateChunk {
  fromDate: string;
  toDate: string;
}

export function parseCliDateStart(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getTime();
}

export function parseCliDateEnd(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999Z`).getTime();
}

export function epochMsToUtcDateStr(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function buildUpstoxHistoricalDateChunks(
  rangeStart: number,
  rangeEnd: number,
  maxChunkDays: number = MAX_UPSTOX_1MINUTE_CHUNK_DAYS,
): HistoricalDateChunk[] {
  if (rangeStart > rangeEnd) {
    throw new Error(`rangeStart (${rangeStart}) must be <= rangeEnd (${rangeEnd})`);
  }
  if (!Number.isFinite(maxChunkDays) || maxChunkDays < 1) {
    throw new Error(`maxChunkDays must be >= 1, got ${maxChunkDays}`);
  }

  const chunks: HistoricalDateChunk[] = [];
  let chunkStart = floorToUtcDay(rangeStart);
  const finalDay = floorToUtcDay(rangeEnd);
  const chunkSpanMs = (maxChunkDays - 1) * DAY_MS;

  while (chunkStart <= finalDay) {
    const chunkEnd = Math.min(chunkStart + chunkSpanMs, finalDay);
    chunks.push({
      fromDate: epochMsToUtcDateStr(chunkStart),
      toDate: epochMsToUtcDateStr(chunkEnd),
    });
    chunkStart = chunkEnd + DAY_MS;
  }

  return chunks;
}

function floorToUtcDay(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
