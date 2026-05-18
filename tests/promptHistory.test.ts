import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPromptDays } from '../server/promptHistory';

let dir: string;
let historyPath: string;

function localMidnightMs(y: number, monthIdx0: number, day: number): number {
  const d = new Date(y, monthIdx0, day, 0, 0, 0, 0);
  return d.getTime();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccdash-prompt-'));
  historyPath = join(dir, 'history.jsonl');

  // Three prompts: two on day A (one in each of two projects), one on day B.
  const dayA = localMidnightMs(2026, 3, 5); // Apr 5, 2026 local
  const dayB = localMidnightMs(2026, 3, 6); // Apr 6, 2026 local

  await writeFile(
    historyPath,
    [
      JSON.stringify({
        display: 'do thing',
        timestamp: dayA + 10 * 3600 * 1000,
        project: '/home/u/projects/foo',
        sessionId: 's1',
      }),
      JSON.stringify({
        display: 'do other thing',
        timestamp: dayA + 14 * 3600 * 1000,
        project: '/home/u/projects/bar',
        sessionId: 's2',
      }),
      JSON.stringify({
        display: 'next day',
        timestamp: dayB + 9 * 3600 * 1000,
        project: '/home/u/projects/foo',
        sessionId: 's3',
      }),
      // Malformed lines should be skipped, not crash the parser.
      'not-json-at-all',
      '',
      JSON.stringify({ display: 'no timestamp', project: '/x' }),
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadPromptDays', () => {
  it('aggregates prompts into days with per-project counts', async () => {
    const days = await loadPromptDays({ path: historyPath });
    expect(days.length).toBe(2);

    const [a, b] = days;
    expect(a!.count).toBe(2);
    expect(a!.byProject).toEqual({ foo: 1, bar: 1 });

    expect(b!.count).toBe(1);
    expect(b!.byProject).toEqual({ foo: 1 });
  });

  it('respects fromMs / toMs window', async () => {
    const dayB = localMidnightMs(2026, 3, 6);
    const onlyB = await loadPromptDays({ path: historyPath, fromMs: dayB });
    expect(onlyB.length).toBe(1);
    expect(onlyB[0]!.count).toBe(1);

    const onlyA = await loadPromptDays({ path: historyPath, toMs: dayB });
    expect(onlyA.length).toBe(1);
    expect(onlyA[0]!.count).toBe(2);
  });

  it('returns empty array when file does not exist', async () => {
    const days = await loadPromptDays({ path: join(dir, 'missing.jsonl') });
    expect(days).toEqual([]);
  });
});
