import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createPiJsonlProvider } from './pi.ts';

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function validProfile(value: string | undefined): string | undefined {
  const profile = value?.trim();
  return profile && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) ? profile : undefined;
}

function defaultDataDir(): string {
  if (process.env.OMP_CODING_AGENT_SESSION_DIR) {
    return expandHome(process.env.OMP_CODING_AGENT_SESSION_DIR);
  }
  if (process.env.OMP_CODING_AGENT_DIR) {
    return join(expandHome(process.env.OMP_CODING_AGENT_DIR), 'sessions');
  }

  const profile = validProfile(process.env.OMP_PROFILE ?? process.env.PI_PROFILE);
  const xdgHome = process.env.XDG_DATA_HOME && expandHome(process.env.XDG_DATA_HOME);
  const xdgRoot = xdgHome
    ? join(xdgHome, 'omp', ...(profile ? ['profiles', profile] : []))
    : undefined;
  if (xdgRoot && existsSync(xdgRoot)) return join(xdgRoot, 'sessions');

  const configDir = process.env.PI_CONFIG_DIR
    ? expandHome(process.env.PI_CONFIG_DIR)
    : join(homedir(), '.omp');
  const configRoot = isAbsolute(configDir) ? configDir : join(homedir(), configDir);
  return join(configRoot, ...(profile ? ['profiles', profile] : []), 'agent', 'sessions');
}

function defaultCachePath(): string {
  return join(homedir(), '.cache', 'tokens-gone', 'omp-cache.json');
}

export const ompProvider = createPiJsonlProvider({
  id: 'omp',
  label: 'Oh My Pi',
  defaultDataDir,
  defaultCachePath,
});
