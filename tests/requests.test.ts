import { describe, expect, it } from 'bun:test';
import { rankRequests, type RequestFilters } from '../server/requests';
import type { Entry } from '../server/types';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    t: Date.parse('2026-09-02T10:00:00Z'),
    p: 'dashboard',
    s: 'session-1',
    m: 'claude-sonnet-4-6',
    i: 100,
    o: 100,
    cc: 0,
    cr: 0,
    f: 0,
    ...over,
  };
}

function filters(over: Partial<RequestFilters> = {}): RequestFilters {
  return {
    from: null,
    to: null,
    projects: new Set(),
    models: new Set(),
    harnesses: new Set(),
    ...over,
  };
}

describe('rankRequests', () => {
  it('returns only the most expensive requests in descending order', () => {
    const result = rankRequests([
      entry({ s: 'cheap', o: 10 }),
      entry({ s: 'highest', o: 10_000 }),
      entry({ s: 'middle', o: 1_000 }),
    ], filters(), 2);

    expect(result.total).toBe(3);
    expect(result.entries.map((request) => request.s)).toEqual(['highest', 'middle']);
    expect(result.entries[0]!.c).toBeGreaterThan(result.entries[1]!.c);
  });

  it('applies exact time, project, model, and harness filters', () => {
    const from = Date.parse('2026-09-02T10:00:00Z');
    const to = Date.parse('2026-09-02T11:00:00Z');
    const result = rankRequests([
      entry({ s: 'before', t: from - 1, p: 'wanted', m: 'claude-opus-4-7', src: 'codex' }),
      entry({ s: 'match', t: from, p: 'wanted', m: 'claude-opus-4-7', src: 'codex' }),
      entry({ s: 'at-end', t: to, p: 'wanted', m: 'claude-opus-4-7', src: 'codex' }),
      entry({ s: 'wrong-project', t: from, p: 'other', m: 'claude-opus-4-7', src: 'codex' }),
      entry({ s: 'wrong-model', t: from, p: 'wanted', m: 'claude-sonnet-4-6', src: 'codex' }),
      entry({ s: 'wrong-harness', t: from, p: 'wanted', m: 'claude-opus-4-7' }),
    ], filters({
      from,
      to,
      projects: new Set(['wanted']),
      models: new Set(['claude-opus-4-7']),
      harnesses: new Set(['codex']),
    }), 50);

    expect(result.total).toBe(1);
    expect(result.entries[0]?.s).toBe('match');
  });

  it('uses provider-supplied costs and strips internal hashes', () => {
    const result = rankRequests([
      entry({ s: 'priced', ci: 0.25, co: 0.5, h: 'private-hash' }),
    ], filters(), 10);

    expect(result.entries[0]?.c).toBe(0.75);
    expect('h' in result.entries[0]!).toBe(false);
  });

  it('uses costs cached during rollup when available', () => {
    const result = rankRequests([
      entry({ s: 'normally-cheap', o: 1 }),
      entry({ s: 'normally-expensive', o: 10_000 }),
    ], filters(), 1, new Float64Array([100, 1]));

    expect(result.entries[0]?.s).toBe('normally-cheap');
    expect(result.entries[0]?.c).toBe(100);
  });
});
