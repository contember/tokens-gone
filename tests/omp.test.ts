import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ompProvider } from '../server/providers/omp';

let root: string;
let sessionsDir: string;
const sessionId = '01a062ff-9013-7000-8496-fd9a956523f2';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tokens-gone-omp-'));
  sessionsDir = join(root, 'sessions');
  const projectDir = join(sessionsDir, '-home-me-projects-tokens-gone');
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `2026-09-02T16-41-50-867Z_${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'title',
        v: 1,
        title: 'Add Oh My Pi support',
        source: 'auto',
        updatedAt: '2026-09-02T16:42:08.671Z',
      }),
      JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: '2026-09-02T16:41:50.867Z',
        cwd: '/home/me/projects/tokens-gone',
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-09-02T16:42:02.378Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'support omp' }],
          timestamp: Date.parse('2026-09-02T16:42:02.378Z'),
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-09-02T16:42:08.159Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          responseModel: 'openai-codex/gpt-5.6-sol',
          timestamp: Date.parse('2026-09-02T16:42:08.159Z'),
          usage: {
            input: 5137,
            output: 94,
            cacheRead: 20864,
            cacheWrite: 0,
            cost: { input: 0.02, output: 0.001, cacheRead: 0.01, cacheWrite: 0 },
          },
        },
      }),
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Oh My Pi provider', () => {
  it('parses OMP sessions with a distinct source and title', async () => {
    const result = await ompProvider.scan({ dataDir: sessionsDir, useCache: false });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      src: 'omp',
      p: 'tokens-gone',
      s: sessionId,
      m: 'openai-codex/gpt-5.6-sol',
      i: 5137,
      o: 94,
      cr: 20864,
    });
    expect(result.sessionMeta[sessionId]).toEqual({
      summary: 'Add Oh My Pi support',
      firstPrompt: 'support omp',
    });
  });

  it('reads OMP transcripts through the shared JSONL parser', async () => {
    const transcript = await ompProvider.readTranscript(sessionId, {
      dataDir: sessionsDir,
      useCache: false,
    });

    expect(transcript.provider).toBe('omp');
    expect(transcript.streams).toHaveLength(1);
    expect(transcript.streams[0]!.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary', text: 'Add Oh My Pi support' }),
        expect.objectContaining({ role: 'user', text: 'support omp' }),
      ]),
    );
  });

  it('honors the OMP sessions override', () => {
    const previous = process.env.OMP_CODING_AGENT_SESSION_DIR;
    process.env.OMP_CODING_AGENT_SESSION_DIR = sessionsDir;
    try {
      expect(ompProvider.defaultDataDir()).toBe(sessionsDir);
    } finally {
      if (previous === undefined) delete process.env.OMP_CODING_AGENT_SESSION_DIR;
      else process.env.OMP_CODING_AGENT_SESSION_DIR = previous;
    }
  });
});
