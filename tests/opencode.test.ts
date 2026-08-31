import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _readOpenCodeTranscript as readOpenCodeTranscript,
  _scanOpenCode as scanOpenCode,
  openCodeProvider,
} from '../server/providers/opencode';
import { flushCacheWrites } from '../server/providers/base';

let dir: string;
let dataDir: string;
let cache: string;
let db: Database;

const sessionId = 'ses_main';
const childId = 'ses_child';

const SCHEMA = `
  create table session (
    id text primary key, parent_id text, directory text not null,
    title text not null, time_created integer not null, time_updated integer not null
  );
  create table message (
    id text primary key, session_id text not null, time_created integer not null,
    time_updated integer not null, data text not null
  );
  create table part (
    id text primary key, message_id text not null, session_id text not null,
    time_created integer not null, time_updated integer not null, data text not null
  );`;

function addSession(id: string, over: { parent_id?: string; title?: string } = {}): void {
  const row = {
    id,
    parent_id: null as string | null,
    directory: '/home/me/projects/tokens-gone',
    title: 'Add OpenCode support',
    time_created: 1788000000000,
    time_updated: 1788000000000,
    ...over,
  };
  db.query(
    `insert into session (id, parent_id, directory, title, time_created, time_updated)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.parent_id, row.directory, row.title, row.time_created, row.time_updated);
}

function addMessage(id: string, session: string, t: number, data: Record<string, unknown>): void {
  db.query(
    `insert into message (id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?)`,
  ).run(id, session, t, t, JSON.stringify(data));
}

function addPart(id: string, messageId: string, session: string, t: number, data: unknown): void {
  db.query(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(id, messageId, session, t, t, JSON.stringify(data));
}

function assistant(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    agent: 'build',
    modelID: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    cost: 0,
    tokens: { input: 100, output: 25, reasoning: 8, cache: { read: 40, write: 5 } },
    time: { created: 1788000010000, completed: 1788000011000 },
    path: { cwd: '/home/me/projects/tokens-gone', root: '/home/me/projects/tokens-gone' },
    ...over,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tokens-gone-opencode-'));
  dataDir = join(dir, 'opencode');
  cache = join(dir, 'opencode-cache.json');
  await mkdir(dataDir, { recursive: true });
  db = new Database(join(dataDir, 'opencode.db'), { create: true });
  db.run(SCHEMA);

  addSession(sessionId);
  addSession(childId, { parent_id: sessionId, title: 'explore the repo' });

  addMessage('msg_user', sessionId, 1788000005000, { role: 'user' });
  addPart('prt_user', 'msg_user', sessionId, 1788000005000, {
    type: 'text',
    text: 'add OpenCode to the dashboard',
  });

  addMessage('msg_a1', sessionId, 1788000010000, assistant());
  addPart('prt_a1_step', 'msg_a1', sessionId, 1788000010000, { type: 'step-start' });
  addPart('prt_a1_text', 'msg_a1', sessionId, 1788000010500, { type: 'text', text: 'on it' });
  addPart('prt_a1_tool', 'msg_a1', sessionId, 1788000010800, {
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'completed', input: { command: 'ls' }, output: 'README.md' },
  });

  addMessage('msg_a2', sessionId, 1788000020000, assistant({
    modelID: 'mystery-model',
    cost: 0.002,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1788000020000, completed: 1788000021000 },
  }));

  addMessage('msg_a3', sessionId, 1788000030000, assistant({
    cost: 0.001,
    time: { created: 1788000030000, completed: 1788000031000 },
  }));

  addMessage('msg_empty', sessionId, 1788000040000, assistant({
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }));

  addMessage('msg_child', childId, 1788000050000, assistant({ agent: 'explore' }));
});

afterAll(async () => {
  await flushCacheWrites();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('opencode scanner', () => {
  it('detects the database inside the data dir', () => {
    expect(openCodeProvider.detect(dataDir)).toBe(true);
    expect(openCodeProvider.detect(join(dir, 'nope'))).toBe(false);
  });

  it('maps assistant token usage and session metadata', async () => {
    const r = await scanOpenCode({ dataDir, cachePath: cache });
    expect(r.stats.files).toBe(2);
    expect(r.entries.length).toBe(4);

    const e = r.entries[0]!;
    expect(e.src).toBe('opencode');
    expect(e.p).toBe('tokens-gone');
    expect(e.s).toBe(sessionId);
    expect(e.m).toBe('claude-sonnet-4-5');
    expect(e.i).toBe(100);
    expect(e.o).toBe(25);
    expect(e.cr).toBe(40);
    expect(e.cc).toBe(5);
    expect(e.h).toBe('opencode:msg_a1');
    expect(e.t).toBe(1788000011000);
    expect(e.ci).toBeUndefined();

    expect(r.sessionMeta[sessionId]).toEqual({
      summary: 'Add OpenCode support',
      firstPrompt: 'add OpenCode to the dashboard',
      agentRole: 'build',
    });
    expect(r.sessionMeta[childId]).toEqual({
      summary: 'explore the repo',
      parentSessionId: sessionId,
      threadSource: 'subagent',
      agentRole: 'explore',
    });
  });

  it('splits a logged cost across the components our price list would bill', async () => {
    const r = await scanOpenCode({ dataDir, cachePath: cache });
    const priced = r.entries.find((entry) => entry.h === 'opencode:msg_a3')!;
    expect(priced.ci! + priced.co! + priced.cwc! + priced.crc!).toBeCloseTo(0.001, 10);
    expect(priced.ci).toBeGreaterThan(0);
    expect(priced.co).toBeGreaterThan(0);
    expect(priced.cwc).toBeGreaterThan(0);
    expect(priced.crc).toBeGreaterThan(0);

    const unpriced = r.entries.find((entry) => entry.h === 'opencode:msg_a2')!;
    expect(unpriced.ci).toBe(0.002);
    expect(unpriced.co).toBeUndefined();
  });

  it('returns an empty result when there is no database', async () => {
    const r = await scanOpenCode({ dataDir: join(dir, 'nope'), useCache: false });
    expect(r.entries.length).toBe(0);
    expect(r.stats.files).toBe(0);
  });

  it('reuses cached sessions on a second scan', async () => {
    await scanOpenCode({ dataDir, cachePath: cache });
    const second = await scanOpenCode({ dataDir, cachePath: cache });
    expect(second.stats.cachedFiles).toBe(second.stats.files);
    expect(second.stats.parsedLines).toBe(0);
  });

  it('re-reads only the session that changed', async () => {
    await scanOpenCode({ dataDir, cachePath: cache });
    addMessage('msg_a4', sessionId, 1788000060000, assistant({
      tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1788000060000, completed: 1788000061000 },
    }));

    const r = await scanOpenCode({ dataDir, cachePath: cache });
    expect(r.entries.length).toBe(5);
    expect(r.stats.cachedFiles).toBe(r.stats.files - 1);
    const added = r.entries.find((entry) => entry.h === 'opencode:msg_a4')!;
    expect(added.i).toBe(7);
    expect(added.o).toBe(3);
  });
});

describe('opencode transcript', () => {
  it('renders messages, tool calls, and usage', async () => {
    const t = await readOpenCodeTranscript(sessionId, { dataDir });
    expect(t.provider).toBe('opencode');
    expect(t.missingRaw).toBe(false);
    expect(t.streams.length).toBe(1);

    const entries = t.streams[0]!.entries;
    expect(entries.some((entry) => entry.role === 'user' && entry.kind === 'message')).toBe(true);

    const toolUse = entries.find((entry) => entry.kind === 'tool_use');
    expect(toolUse?.toolName).toBe('bash');
    const toolResult = entries.find((entry) => entry.kind === 'tool_result');
    expect(toolResult?.text).toBe('README.md');

    const withUsage = entries.filter((entry) => entry.usageKey === 'opencode:msg_a1');
    expect(withUsage.length).toBeGreaterThan(0);
    const tokens = withUsage.find((entry) => entry.tokens)?.tokens;
    expect(tokens).toEqual({ input: 100, output: 25, cacheWrite: 5, cacheRead: 40 });
  });

  it('reports missing raw data for an unknown session', async () => {
    const t = await readOpenCodeTranscript('ses_unknown', { dataDir });
    expect(t.missingRaw).toBe(true);
    expect(t.streams.length).toBe(0);
  });
});
