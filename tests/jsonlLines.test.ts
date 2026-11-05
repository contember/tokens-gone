import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlLines } from '../server/providers/base';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jsonl-lines-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readAll(path: string, from = 0): Promise<{ lines: string[]; endOffset: number }> {
  const reader = new JsonlLines(path, from);
  const lines: string[] = [];
  for await (const line of reader) lines.push(line);
  return { lines, endOffset: reader.endOffset };
}

describe('JsonlLines', () => {
  it('stops before a half-written last line and resumes it once complete', async () => {
    const path = join(dir, 'partial.jsonl');
    const first = JSON.stringify({ n: 1, text: 'žluťoučký' });
    const second = JSON.stringify({ n: 2 });
    await writeFile(path, `${first}\n${second.slice(0, 4)}`);

    const head = await readAll(path);
    expect(head.lines).toEqual([first]);
    expect(head.endOffset).toBe(Buffer.byteLength(first) + 1);

    await appendFile(path, `${second.slice(4)}\n`);
    const tail = await readAll(path, head.endOffset);
    expect(tail.lines).toEqual([second]);
    expect(tail.endOffset).toBe(Buffer.byteLength(`${first}\n${second}\n`));
  });

  it('accepts a final line without newline when it is complete JSON', async () => {
    const path = join(dir, 'no-trailing-newline.jsonl');
    await writeFile(path, '{"a":1}\n{"b":2}');
    const r = await readAll(path);
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.endOffset).toBe(15);
  });

  it('joins lines that span read chunks and strips CRLF', async () => {
    const path = join(dir, 'long.jsonl');
    const long = JSON.stringify({ blob: 'x'.repeat(3 * 1024 * 1024) });
    await writeFile(path, `{"a":1}\r\n${long}\n{"b":2}\n`);
    const r = await readAll(path);
    expect(r.lines.length).toBe(3);
    expect(r.lines[0]).toBe('{"a":1}');
    expect(r.lines[1]).toBe(long);
    expect(r.lines[2]).toBe('{"b":2}');
  });
});
