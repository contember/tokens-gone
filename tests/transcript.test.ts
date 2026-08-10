import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _readClaudeTranscript } from '../server/providers/claude';
import { _readCodexTranscript } from '../server/providers/codex';
import { _readPiTranscript } from '../server/providers/pi';
import { markTranscriptUsageOwnership } from '../server/providers/transcript';
import type { Entry, SessionTranscript } from '../server/types';

describe('transcript readers', () => {
  it('marks only the aggregate-owned copy of mirrored transcript usage', () => {
    const transcript: SessionTranscript = {
      sessionId: 'sess-owned',
      provider: 'cc',
      sourceFiles: 2,
      totalEntries: 3,
      missingRaw: false,
      streams: [
        {
          id: 'main',
          label: 'Main',
          path: 'main.jsonl',
          kind: 'main',
          isSidechain: false,
          entries: [{
            id: 'main:1',
            role: 'assistant',
            kind: 'message',
            title: 'Assistant',
            rawType: 'assistant',
            isSidechain: false,
            isCompactSummary: false,
            model: 'claude-sonnet-4-6',
            usageKey: 'msg-owned:req-owned',
            tokens: { input: 10, output: 20 },
          }],
        },
        {
          id: 'subagent',
          label: 'Subagent',
          path: 'subagents/agent.jsonl',
          kind: 'subagent',
          isSidechain: true,
          entries: [
            {
              id: 'subagent:1',
              role: 'assistant',
              kind: 'message',
              title: 'Assistant',
              rawType: 'assistant',
              isSidechain: true,
              isCompactSummary: false,
              model: 'claude-sonnet-4-6',
              usageKey: 'msg-owned:req-owned',
              tokens: { input: 10, output: 20 },
            },
            {
              id: 'subagent:2',
              role: 'assistant',
              kind: 'message',
              title: 'Assistant',
              rawType: 'assistant',
              isSidechain: true,
              isCompactSummary: false,
              model: 'claude-sonnet-4-6',
              usageKey: 'msg-other:req-other',
              tokens: { input: 5, output: 6 },
            },
          ],
        },
      ],
    };
    const aggregateEntries: Entry[] = [{
      t: 1,
      p: 'project',
      s: 'sess-owned',
      m: 'claude-sonnet-4-6',
      i: 10,
      o: 20,
      cc: 0,
      cr: 0,
      f: 0,
      h: 'msg-owned:req-owned',
    }];

    markTranscriptUsageOwnership(transcript, aggregateEntries);

    expect(transcript.streams[0]!.entries[0]!.counted).toBe(true);
    expect(transcript.streams[1]!.entries[0]!.counted).toBe(false);
    expect(transcript.streams[1]!.entries[1]!.counted).toBe(false);
  });

  it('reads Claude main log, compaction markers, and subagent streams', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokens-gone-transcript-'));
    try {
      const projects = join(dir, 'projects');
      const projectDir = join(projects, '-home-me-projects-tokens-gone');
      await mkdir(join(projectDir, 'subagents'), { recursive: true });

      await writeFile(
        join(projectDir, 'sess-log.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-06-01T09:00:00.000Z',
            sessionId: 'sess-log',
            isSidechain: false,
            uuid: 'u-main',
            message: { role: 'user', content: 'hello main' },
          }),
          JSON.stringify({
            type: 'attachment',
            timestamp: '2026-06-01T09:00:00.500Z',
            sessionId: 'sess-log',
            isSidechain: false,
            uuid: 'att-main',
            attachment: {
              type: 'queued_command',
              prompt: [
                { type: 'text', text: '[Image #1] inspect this chart' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJgJ2QAAAABJRU5ErkJggg==',
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-06-01T09:00:01.000Z',
            sessionId: 'sess-log',
            isSidechain: false,
            uuid: 'a-main',
            requestId: 'req-main',
            message: {
              id: 'msg-main',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [
                { type: 'text', text: 'I will run a command.' },
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
              ],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 1,
                cache_read_input_tokens: 2,
                speed: 'fast',
              },
            },
          }),
          JSON.stringify({
            type: 'progress',
            timestamp: '2026-06-01T09:00:01.500Z',
            sessionId: 'sess-log',
            isSidechain: false,
            uuid: 'p-image',
            data: {
              note: 'rendered screenshot',
              screenshot: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJgJ2QAAAABJRU5ErkJggg==',
              },
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-06-01T09:00:02.000Z',
            sessionId: 'sess-log',
            isSidechain: false,
            uuid: 'u-tool',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
            },
          }),
          JSON.stringify({
            type: 'system',
            subtype: 'away_summary',
            timestamp: '2026-06-01T09:00:03.000Z',
            sessionId: 'sess-log',
            isSidechain: false,
            uuid: 's-summary',
            content: 'Compacted context summary',
          }),
        ].join('\n'),
      );

      await writeFile(
        join(projectDir, 'subagents', 'agent.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-06-01T09:01:00.000Z',
            sessionId: 'sess-log',
            isSidechain: true,
            uuid: 'u-sub',
            agentId: 'agent-1',
            message: { role: 'user', content: 'subagent prompt' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-06-01T09:01:01.000Z',
            sessionId: 'sess-log',
            isSidechain: true,
            uuid: 'a-sub',
            agentId: 'agent-1',
            message: {
              role: 'assistant',
              model: 'claude-opus-4-7',
              content: [{ type: 'text', text: 'subagent answer' }],
            },
          }),
        ].join('\n'),
      );

      const transcript = await _readClaudeTranscript('sess-log', {
        dataDir: projects,
        concurrency: 1,
      });
      const entries = transcript.streams.flatMap((stream) => stream.entries);

      expect(transcript.missingRaw).toBe(false);
      expect(transcript.streams.length).toBe(2);
      expect(transcript.streams.some((stream) => stream.kind === 'subagent')).toBe(true);
      expect(entries.some((entry) => entry.kind === 'tool_use' && entry.toolName === 'Bash')).toBe(true);
      expect(entries.some((entry) => entry.kind === 'tool_result' && entry.text === 'ok')).toBe(true);
      expect(entries.some((entry) => entry.kind === 'summary' && entry.isCompactSummary)).toBe(true);
      const attachment = entries.find((entry) => entry.kind === 'attachment');
      expect(attachment?.title).toBe('Attachment · queued_command');
      expect(attachment?.text).toBe('[Image #1] inspect this chart');
      expect(attachment?.images?.[0]?.mediaType).toBe('image/png');
      expect(attachment?.images?.[0]?.data.startsWith('iVBOR')).toBe(true);
      expect(attachment?.text?.includes('iVBOR')).toBe(false);
      const progress = entries.find((entry) => entry.kind === 'progress');
      expect(progress?.images?.[0]?.mediaType).toBe('image/png');
      expect(progress?.images?.[0]?.data.startsWith('iVBOR')).toBe(true);
      expect(progress?.text?.includes('iVBOR')).toBe(false);
      expect(progress?.text?.includes('image/png omitted')).toBe(true);
      const billed = entries.find((entry) => entry.tokens?.output === 5);
      expect(billed?.usageKey).toBe('msg-main:req-main');
      expect(billed?.fast).toBe(1);

      const missing = await _readClaudeTranscript('missing-session', {
        dataDir: projects,
        concurrency: 1,
      });
      expect(missing.missingRaw).toBe(true);
      expect(missing.totalEntries).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads Codex and Pi raw session logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokens-gone-transcript-other-'));
    try {
      const codexDir = join(dir, 'codex', '2026', '04', '29');
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-04-29T09:45:45.778Z',
            type: 'session_meta',
            payload: { id: 'codex-session', cwd: '/home/me/projects/tokens-gone' },
          }),
          JSON.stringify({
            timestamp: '2026-04-29T09:45:45.778Z',
            type: 'session_meta',
            payload: { id: 'codex-parent-session', cwd: '/home/me/projects/tokens-gone' },
          }),
          JSON.stringify({
            timestamp: '2026-04-29T09:45:45.779Z',
            type: 'turn_context',
            payload: { model: 'gpt-5.5', effort: 'medium' },
          }),
          JSON.stringify({
            timestamp: '2026-04-29T09:45:45.780Z',
            type: 'event_msg',
            payload: { type: 'user_message', message: 'codex prompt' },
          }),
          JSON.stringify({
            timestamp: '2026-04-29T09:45:46.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 20,
                  cached_input_tokens: 5,
                  output_tokens: 3,
                },
              },
            },
          }),
        ].join('\n'),
      );

      const codex = await _readCodexTranscript('codex-session', {
        dataDir: join(dir, 'codex'),
        concurrency: 1,
      });
      const codexEntries = codex.streams.flatMap((stream) => stream.entries);
      expect(codex.provider).toBe('codex');
      expect(codexEntries.some((entry) => entry.text === 'codex prompt')).toBe(true);
      expect(codexEntries.some((entry) => entry.tokens?.cacheRead === 5)).toBe(true);

      const piDir = join(dir, 'pi', '--home-me-projects-tokens-gone--');
      await mkdir(piDir, { recursive: true });
      await writeFile(
        join(piDir, 'session.jsonl'),
        [
          JSON.stringify({
            type: 'session',
            timestamp: '2026-06-01T09:00:00.000Z',
            session: { id: 'pi-session', cwd: '/home/me/projects/tokens-gone' },
          }),
          JSON.stringify({
            type: 'message',
            timestamp: '2026-06-01T09:01:00.000Z',
            message: { role: 'user', content: 'pi prompt' },
          }),
          JSON.stringify({
            type: 'message',
            timestamp: '2026-06-01T09:02:00.000Z',
            message: {
              role: 'assistant',
              content: 'pi answer',
              responseModel: 'anthropic/claude-sonnet-4-6',
              usage: { input: 8, output: 2, cacheRead: 4 },
            },
          }),
        ].join('\n'),
      );

      const pi = await _readPiTranscript('pi-session', {
        dataDir: join(dir, 'pi'),
        concurrency: 1,
      });
      const piEntries = pi.streams.flatMap((stream) => stream.entries);
      expect(pi.provider).toBe('pi');
      expect(piEntries.some((entry) => entry.text === 'pi prompt')).toBe(true);
      expect(piEntries.some((entry) => entry.tokens?.cacheRead === 4)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
