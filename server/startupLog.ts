/**
 * Everything the CLI prints while booting: banner, detected sources, the
 * scan spinner, and the closing line. The dashboard URL is printed both
 * first and last, so it stays visible under the usage numbers when the
 * browser doesn't open on its own.
 */

import { homedir } from 'node:os';
import type { Style } from './ansi.ts';
import type { ProviderScanStats } from './providers/index.ts';
import { VERSION } from './version.ts';

export type SourceInfo = { label: string; dir: string; detected: boolean };

export type ScanReport = {
  entries: number;
  stats: ProviderScanStats;
  providers: { label: string; detected: boolean; stats: ProviderScanStats }[];
};

const num = (n: number): string => n.toLocaleString('en-US');

function shortenHome(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function urlLine(st: Style, url: string, hint?: string): string {
  const link = st.bold(st.cyan(st.underline(url)));
  return `  ${st.green('→')} ${st.bold('Dashboard')}  ${link}${hint ? `  ${st.dim(hint)}` : ''}`;
}

export function printBanner(st: Style, url: string, sources: SourceInfo[]): void {
  const labelW = Math.max(...sources.map((s) => s.label.length));
  console.log('');
  const version = VERSION === 'dev' ? 'dev' : `v${VERSION}`;
  console.log(`  ${st.bold('tokens-gone')} ${st.dim(version)}`);
  console.log(urlLine(st, url));
  console.log('');
  console.log(`  ${st.dim('Sources')}`);
  for (const s of sources) {
    const label = s.label.padEnd(labelW);
    if (s.detected) {
      console.log(`    ${st.green('●')} ${label}  ${st.dim(shortenHome(s.dir))}`);
    } else {
      console.log(`    ${st.dim('○')} ${st.dim(label)}  ${st.dim('not detected')}`);
    }
  }
  console.log('');
}

/** Animated only on a TTY; elsewhere it degrades to a single static line. */
export function startSpinner(st: Style, text: string): () => void {
  if (!process.stdout.isTTY) {
    console.log(`  ${text}`);
    return () => {};
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const draw = (): void => {
    process.stdout.write(`\r  ${st.cyan(frames[i++ % frames.length]!)} ${st.dim(text)}`);
  };
  draw();
  const timer = setInterval(draw, 90);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  };
}

export function printScanResult(st: Style, report: ScanReport): void {
  const { files, cachedFiles, tookMs } = report.stats;
  console.log(
    `  ${st.green('✔')} ${st.bold(num(report.entries))} requests ${st.dim('·')} ` +
      `${num(files)} files ${st.dim(`(${num(cachedFiles)} cached)`)} ${st.dim('·')} ${duration(tookMs)}`,
  );
  const detected = report.providers.filter((p) => p.detected);
  if (detected.length > 1) {
    const parts = detected.map((p) => `${p.label} ${num(p.stats.files)}`);
    console.log(`    ${st.dim(parts.join(' · '))}`);
  }
}

export function printScanFailure(st: Style, err: unknown): void {
  console.log(`  ${st.red('✖')} Initial scan failed ${st.dim('— the dashboard will retry on refresh')}`);
  console.error(err);
}

export function printFooter(st: Style, url: string): void {
  console.log('');
  console.log(urlLine(st, url, '(Ctrl+C to stop)'));
  console.log('');
}
