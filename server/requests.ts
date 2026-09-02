import { costBreakdownForEntry } from './pricing.ts';
import type { Entry } from './types.ts';

export type RequestHarness = NonNullable<Entry['src']>;

export type RequestFilters = {
  from: number | null;
  to: number | null;
  projects: Set<string>;
  models: Set<string>;
  harnesses: Set<RequestHarness>;
};

export type RankedRequest = Omit<Entry, 'h'> & {
  /** Authoritative per-request cost in USD. */
  c: number;
};

type ScoredRequest = {
  entry: Entry;
  cost: number;
  index: number;
};

export function rankRequests(
  entries: Entry[],
  filters: RequestFilters,
  limit: number,
  requestCosts?: Float64Array,
): { entries: RankedRequest[]; total: number } {
  limit = Math.max(0, Math.floor(limit));
  const heap: ScoredRequest[] = [];
  let total = 0;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!matchesRequest(entry, filters)) continue;
    total++;
    if (limit === 0) continue;

    const cost = requestCosts?.[index] ?? requestCost(entry);
    if (heap.length < limit) {
      pushHeap(heap, { entry, cost, index });
    } else if (compareValues(cost, entry.t, index, heap[0]!) > 0) {
      heap[0] = { entry, cost, index };
      sinkHeap(heap, 0);
    }
  }

  heap.sort((a, b) => compareRank(b, a));
  return {
    entries: heap.map(({ entry, cost }) => {
      const { h: _hash, ...publicEntry } = entry;
      return { ...publicEntry, c: Math.round(cost * 1e9) / 1e9 };
    }),
    total,
  };
}

function requestCost(entry: Entry): number {
  const cost = costBreakdownForEntry(entry);
  return cost.input + cost.output + cost.cacheWrite + cost.cacheRead;
}

function matchesRequest(entry: Entry, filters: RequestFilters): boolean {
  if (filters.from !== null && entry.t < filters.from) return false;
  if (filters.to !== null && entry.t >= filters.to) return false;
  if (filters.projects.size > 0 && !filters.projects.has(entry.p)) return false;
  if (filters.models.size > 0 && !filters.models.has(entry.m)) return false;
  if (filters.harnesses.size > 0 && !filters.harnesses.has(entry.src ?? 'cc')) return false;
  return true;
}

/** Ascending rank: the least valuable heap item sorts first. */
function compareRank(a: ScoredRequest, b: ScoredRequest): number {
  return compareValues(a.cost, a.entry.t, a.index, b);
}

function compareValues(
  cost: number,
  timestamp: number,
  index: number,
  other: ScoredRequest,
): number {
  if (cost !== other.cost) return cost - other.cost;
  if (timestamp !== other.entry.t) return timestamp - other.entry.t;
  return index - other.index;
}

function pushHeap(heap: ScoredRequest[], value: ScoredRequest): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRank(heap[parent]!, value) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function sinkHeap(heap: ScoredRequest[], start: number): void {
  const value = heap[start]!;
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && compareRank(heap[right]!, heap[left]!) < 0
      ? right
      : left;
    if (compareRank(heap[child]!, value) >= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = value;
}
