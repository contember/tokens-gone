import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, relative, sep } from 'node:path';
import type {
  TranscriptEntry,
  TranscriptEntryKind,
  TranscriptField,
  TranscriptImage,
  TranscriptRole,
  TranscriptStream,
  TranscriptTokens,
} from '../types.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function arrayField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

export async function readJsonlObjects(
  path: string,
  onObject: (json: Record<string, unknown>, lineNo: number) => void,
): Promise<number> {
  let lineNo = 0;
  const stream = createReadStream(path, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed)) onObject(parsed, lineNo);
  }
  return lineNo;
}

export function parseTimestampMs(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') continue;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

export function providerPath(dataDir: string, path: string): string {
  return relative(dataDir, path).split(sep).join('/');
}

export function streamKindFromPath(path: string): 'main' | 'subagent' {
  return path.split(sep).includes('subagents') ? 'subagent' : 'main';
}

export function streamLabel(relativePath: string, kind: 'main' | 'subagent'): string {
  if (kind === 'subagent') {
    const parts = relativePath.split('/');
    const idx = parts.indexOf('subagents');
    const label = idx >= 0 ? parts.slice(idx + 1).join('/') : basename(relativePath);
    return label ? `Subagent · ${label}` : 'Subagent';
  }
  return `Main · ${basename(relativePath)}`;
}

export function sortStreams(streams: TranscriptStream[]): void {
  streams.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1;
    const at = firstEntryTime(a);
    const bt = firstEntryTime(b);
    if (at !== bt) return at - bt;
    return a.path.localeCompare(b.path);
  });
}

function firstEntryTime(stream: TranscriptStream): number {
  for (const entry of stream.entries) {
    if (entry.t !== undefined) return entry.t;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function countEntries(streams: TranscriptStream[]): number {
  let total = 0;
  for (const stream of streams) total += stream.entries.length;
  return total;
}

export function textFromUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = textFromContentBlock(item);
      if (part) parts.push(part);
    }
    if (parts.length > 0) return parts.join('\n\n');
  }
  const json = JSON.stringify(sanitizeForDisplay(value), null, 2);
  return json === undefined ? undefined : json;
}

function textFromContentBlock(value: unknown): string | undefined {
  if (!isRecord(value)) return textFromUnknown(value);
  const type = stringField(value, 'type');
  if (type === 'image' || type === 'input_image') {
    const image = imageFromRecord(value, 'Image');
    return image ? `${image.label ?? 'Image'} · ${image.mediaType}` : 'Image';
  }
  const text = stringField(value, 'text') ?? stringField(value, 'thinking');
  if (text !== undefined) return text;
  const content = value.content;
  const nested = textFromUnknown(content);
  if (nested !== undefined) return nested;
  if (type) return textFromUnknown(value);
  return undefined;
}

function sanitizeForDisplay(value: unknown, key?: string, holder?: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return summarizedBinaryString(key, value, holder) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitizeForDisplay(childValue, childKey, value);
    }
    return out;
  }
  return value;
}

function summarizedBinaryString(
  key: string | undefined,
  value: string,
  holder: Record<string, unknown> | undefined,
): string | undefined {
  const lowerKey = key?.toLowerCase();
  const mediaType = holder
    ? stringField(holder, 'media_type') ?? stringField(holder, 'mediaType') ?? stringField(holder, 'mime_type')
    : undefined;
  const sourceType = holder ? stringField(holder, 'type') : undefined;
  const imageLike = mediaType?.startsWith('image/') === true;
  if (!imageLike && value.length < 256) return undefined;
  if (!imageLike && !looksLikeBase64(value) && !imageFromDataUri(value, 'Image')) return undefined;
  const binaryLike =
    lowerKey === 'data' ||
    lowerKey === 'base64' ||
    lowerKey?.includes('base64') === true ||
    sourceType === 'base64';

  if (!binaryLike && !imageLike) return undefined;
  const label = imageLike ? mediaType : 'base64 data';
  return `[${label} omitted, ${formatBytes(estimatedBase64Bytes(value))}]`;
}

function looksLikeBase64(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  if (compact.length < 256) return false;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function estimatedBase64Bytes(value: string): number {
  const compact = value.replace(/\s/g, '');
  let padding = 0;
  if (compact.endsWith('==')) padding = 2;
  else if (compact.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isCompactLike(record: Record<string, unknown>): boolean {
  if (booleanField(record, 'isCompactSummary') === true) return true;
  const type = stringField(record, 'type')?.toLowerCase();
  const subtype = stringField(record, 'subtype')?.toLowerCase();
  return type === 'summary' || subtype?.includes('summary') === true || subtype?.includes('compact') === true;
}

export function metaFromRoot(record: Record<string, unknown>): string[] | undefined {
  const meta: string[] = [];
  const agentId = stringField(record, 'agentId');
  const slug = stringField(record, 'slug');
  const uuid = stringField(record, 'uuid');
  if (agentId) meta.push(`agent ${agentId}`);
  if (slug) meta.push(slug);
  if (uuid) meta.push(uuid.slice(0, 8));
  return meta.length > 0 ? meta : undefined;
}

export function messageEntries({
  idBase,
  rawType,
  role,
  content,
  timestamp,
  model,
  isSidechain,
  isCompactSummary,
  tokens,
  meta,
}: {
  idBase: string;
  rawType: string;
  role: TranscriptRole;
  content: unknown;
  timestamp?: number;
  model?: string;
  isSidechain: boolean;
  isCompactSummary: boolean;
  tokens?: TranscriptTokens;
  meta?: string[];
}): TranscriptEntry[] {
  if (Array.isArray(content)) {
    const entries: TranscriptEntry[] = [];
    let blockIndex = 0;
    for (const block of content) {
      const entry = entryFromBlock({
        id: `${idBase}:${blockIndex}`,
        rawType,
        fallbackRole: role,
        block,
        timestamp,
        model,
        isSidechain,
        isCompactSummary,
        tokens: blockIndex === content.length - 1 ? tokens : undefined,
        meta,
      });
      blockIndex++;
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) return entries;
  }

  const text = textFromUnknown(content);
  const images = imagesFromUnknown(content);
  return [{
    id: idBase,
    role,
    kind: isCompactSummary ? 'summary' : 'message',
    title: isCompactSummary ? 'Context compaction' : roleTitle(role),
    rawType,
    isSidechain,
    isCompactSummary,
    t: timestamp,
    text,
    images,
    model,
    tokens,
    meta,
  }];
}

function entryFromBlock({
  id,
  rawType,
  fallbackRole,
  block,
  timestamp,
  model,
  isSidechain,
  isCompactSummary,
  tokens,
  meta,
}: {
  id: string;
  rawType: string;
  fallbackRole: TranscriptRole;
  block: unknown;
  timestamp?: number;
  model?: string;
  isSidechain: boolean;
  isCompactSummary: boolean;
  tokens?: TranscriptTokens;
  meta?: string[];
}): TranscriptEntry | undefined {
  if (!isRecord(block)) {
    const text = textFromUnknown(block);
    if (text === undefined) return undefined;
    return {
      id,
      role: fallbackRole,
      kind: 'message',
      title: roleTitle(fallbackRole),
      rawType,
      isSidechain,
      isCompactSummary,
      t: timestamp,
      text,
      model,
      tokens,
      meta,
    };
  }

  const blockType = stringField(block, 'type') ?? 'block';
  if (blockType === 'tool_use') {
    const toolName = stringField(block, 'name') ?? 'tool';
    const input = block.input;
    return {
      id,
      role: 'assistant',
      kind: 'tool_use',
      title: `Tool use · ${toolName}`,
      rawType,
      isSidechain,
      isCompactSummary,
      t: timestamp,
      text: textFromUnknown(input),
      model,
      toolName,
      tokens,
      meta,
      fields: toolInputFields(input),
      images: imagesFromUnknown(input),
    };
  }

  if (blockType === 'tool_result') {
    const toolUseId = stringField(block, 'tool_use_id');
    const content = block.content;
    return {
      id,
      role: 'tool',
      kind: 'tool_result',
      title: toolUseId ? `Tool result · ${toolUseId.slice(0, 12)}` : 'Tool result',
      rawType,
      isSidechain,
      isCompactSummary,
      t: timestamp,
      text: textFromUnknown(content),
      model,
      tokens,
      meta,
      images: imagesFromUnknown(content),
    };
  }

  if (blockType === 'thinking') {
    return {
      id,
      role: 'assistant',
      kind: 'thinking',
      title: 'Thinking',
      rawType,
      isSidechain,
      isCompactSummary,
      t: timestamp,
      text: stringField(block, 'thinking') ?? textFromUnknown(block),
      model,
      tokens,
      meta,
    };
  }

  if (blockType === 'image' || blockType === 'input_image') {
    const image = imageFromRecord(block, 'Image');
    return {
      id,
      role: fallbackRole,
      kind: 'attachment',
      title: image ? image.label ?? 'Image' : 'Image',
      rawType,
      isSidechain,
      isCompactSummary,
      t: timestamp,
      text: image ? undefined : textFromUnknown(block),
      model,
      tokens,
      meta,
      images: image ? [image] : undefined,
    };
  }

  const kind: TranscriptEntryKind =
    blockType === 'text' || blockType === 'input_text' || blockType === 'output_text'
      ? 'message'
      : 'event';
  return {
    id,
    role: fallbackRole,
    kind,
    title: kind === 'message' ? roleTitle(fallbackRole) : `Block · ${blockType}`,
    rawType,
    isSidechain,
    isCompactSummary,
    t: timestamp,
    text: textFromUnknown(block),
    model,
    tokens,
    meta,
    images: imagesFromUnknown(block),
  };
}

export function attachmentEntry({
  id,
  rawType,
  attachment,
  timestamp,
  isSidechain,
  isCompactSummary,
  meta,
}: {
  id: string;
  rawType: string;
  attachment: unknown;
  timestamp?: number;
  isSidechain: boolean;
  isCompactSummary: boolean;
  meta?: string[];
}): TranscriptEntry {
  const record = isRecord(attachment) ? attachment : undefined;
  const attachmentType = record ? stringField(record, 'type') : undefined;
  const prompt = record ? arrayField(record, 'prompt') ?? arrayField(record, 'content') : undefined;
  const textParts: string[] = [];
  const images: TranscriptImage[] = [];

  if (prompt) {
    for (const block of prompt) {
      const image = isRecord(block) ? imageFromRecord(block, `Image ${images.length + 1}`) : undefined;
      if (image) {
        appendImage(images, image);
        continue;
      }
      const text = textFromContentBlock(block);
      if (text) textParts.push(text);
    }
  }

  appendImages(images, imagesFromUnknown(attachment));

  const fields: TranscriptField[] = [];
  if (attachmentType) fields.push({ label: 'type', value: attachmentType });
  if (prompt) fields.push({ label: 'prompt blocks', value: String(prompt.length) });
  if (images.length > 0) fields.push({ label: 'images', value: String(images.length) });

  const fallbackText = textParts.length > 0 ? textParts.join('\n\n') : textFromUnknown(attachment);
  return {
    id,
    role: 'event',
    kind: 'attachment',
    title: attachmentType ? `Attachment · ${attachmentType}` : 'Attachment',
    rawType,
    isSidechain,
    isCompactSummary,
    t: timestamp,
    text: fallbackText,
    meta,
    fields: fields.length > 0 ? fields : undefined,
    images: images.length > 0 ? images : undefined,
  };
}

export function imagesFromUnknown(value: unknown): TranscriptImage[] | undefined {
  const images: TranscriptImage[] = [];
  collectImages(value, images);
  return images.length > 0 ? images : undefined;
}

function collectImages(value: unknown, images: TranscriptImage[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, images);
    return;
  }
  if (!isRecord(value)) {
    const image = typeof value === 'string'
      ? imageFromDataUri(value, `Image ${images.length + 1}`)
      : undefined;
    if (image) appendImage(images, image);
    return;
  }

  const image = imageFromRecord(value, `Image ${images.length + 1}`);
  if (image) {
    appendImage(images, image);
    return;
  }

  for (const childValue of Object.values(value)) {
    collectImages(childValue, images);
  }
}

function imageFromRecord(record: Record<string, unknown>, label: string): TranscriptImage | undefined {
  const type = stringField(record, 'type');
  if (type === 'image' || type === 'input_image') {
    return imageFromSource(recordField(record, 'source') ?? record, record, label);
  }
  return imageFromSource(record, undefined, label);
}

function imageFromSource(
  source: Record<string, unknown>,
  wrapper: Record<string, unknown> | undefined,
  label: string,
): TranscriptImage | undefined {
  const mediaType =
    stringField(source, 'media_type') ??
    stringField(source, 'mediaType') ??
    stringField(source, 'mime_type') ??
    (wrapper
      ? stringField(wrapper, 'media_type') ?? stringField(wrapper, 'mediaType') ?? stringField(wrapper, 'mime_type')
      : undefined) ??
    'image/png';
  const data = stringField(source, 'data') ?? stringField(source, 'base64');
  if (!data) return undefined;
  const dataUri = imageFromDataUri(data, label);
  if (dataUri) return dataUri;
  if (!mediaType.startsWith('image/')) return undefined;
  const sourceType = stringField(source, 'type');
  const base64Like =
    sourceType === undefined ||
    sourceType === 'base64' ||
    sourceType === 'image' ||
    sourceType === 'input_image';
  if (!base64Like && !looksLikeBase64(data)) return undefined;
  return { mediaType, data, label };
}

function imageFromDataUri(value: string, label: string): TranscriptImage | undefined {
  if (!value.startsWith('data:image/')) return undefined;
  const marker = ';base64,';
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const mediaType = value.slice('data:'.length, markerIndex);
  const data = value.slice(markerIndex + marker.length);
  if (!mediaType.startsWith('image/') || !data) return undefined;
  return { mediaType, data, label };
}

function appendImages(images: TranscriptImage[], additions: TranscriptImage[] | undefined): void {
  if (!additions) return;
  for (const image of additions) appendImage(images, image);
}

function appendImage(images: TranscriptImage[], image: TranscriptImage): void {
  if (images.some((existing) => existing.mediaType === image.mediaType && existing.data === image.data)) return;
  images.push(image);
}

function toolInputFields(input: unknown): TranscriptField[] | undefined {
  if (!isRecord(input)) return undefined;
  const fields: TranscriptField[] = [];
  addField(fields, 'command', stringField(input, 'command') ?? stringField(input, 'cmd'));
  addField(fields, 'path', stringField(input, 'path') ?? stringField(input, 'file_path') ?? stringField(input, 'file'));
  addField(fields, 'pattern', stringField(input, 'pattern') ?? stringField(input, 'query'));
  addField(fields, 'url', stringField(input, 'url'));
  addField(fields, 'description', stringField(input, 'description'));
  return fields.length > 0 ? fields : undefined;
}

function addField(fields: TranscriptField[], label: string, value: string | undefined): void {
  if (!value) return;
  fields.push({ label, value: truncateFieldValue(value) });
}

function truncateFieldValue(value: string): string {
  if (value.length <= 240) return value;
  return `${value.slice(0, 237)}...`;
}

export function roleFromString(role: string | undefined): TranscriptRole {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'event';
}

export function roleTitle(role: TranscriptRole): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  if (role === 'tool') return 'Tool';
  return 'Event';
}

export function claudeTokens(message: Record<string, unknown>): TranscriptTokens | undefined {
  const usage = recordField(message, 'usage');
  if (!usage) return undefined;
  return presentTokens({
    input: numberField(usage, 'input_tokens'),
    output: numberField(usage, 'output_tokens'),
    cacheWrite: numberField(usage, 'cache_creation_input_tokens'),
    cacheRead: numberField(usage, 'cache_read_input_tokens'),
  });
}

export function codexTokens(usage: Record<string, unknown> | undefined): TranscriptTokens | undefined {
  if (!usage) return undefined;
  const input = numberField(usage, 'input_tokens');
  const cached = numberField(usage, 'cached_input_tokens') ?? 0;
  const output = numberField(usage, 'output_tokens');
  return presentTokens({
    input: input === undefined ? undefined : Math.max(0, input - cached),
    output,
    cacheRead: cached,
  });
}

export function piTokens(message: Record<string, unknown>): TranscriptTokens | undefined {
  const usage = recordField(message, 'usage');
  if (!usage) return undefined;
  const cacheWrite = (numberField(usage, 'cacheWrite') ?? 0) + (numberField(usage, 'cacheWrite1h') ?? 0);
  return presentTokens({
    input: numberField(usage, 'input'),
    output: numberField(usage, 'output'),
    cacheWrite,
    cacheRead: numberField(usage, 'cacheRead'),
  });
}

function presentTokens(tokens: TranscriptTokens): TranscriptTokens | undefined {
  const hasAny =
    tokens.input !== undefined ||
    tokens.output !== undefined ||
    tokens.cacheWrite !== undefined ||
    tokens.cacheRead !== undefined;
  return hasAny ? tokens : undefined;
}
