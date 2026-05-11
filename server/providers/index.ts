/**
 * Registered providers. Adding a new harness (e.g. OpenCode) is a matter of:
 *   1. Implementing the `Provider` interface in `./<name>.ts`
 *   2. Adding `'<name>'` to `ProviderId` in `./types.ts`
 *   3. Pushing the new provider into the list below
 *
 * Order doesn't affect correctness — the server merges results — but it
 * does affect log readability, so we keep the canonical Claude Code first.
 */

import type { Provider } from './types.ts';
import { claudeProvider } from './claude.ts';
import { codexProvider } from './codex.ts';

export const PROVIDERS: readonly Provider[] = [claudeProvider, codexProvider];

export type { Provider, ProviderId, ProviderScanResult, ProviderScanStats } from './types.ts';
