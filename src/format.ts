export function fmtMoney(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtRelativeDay(t: number, now = Date.now()): string {
  const diffMs = now - t;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day && new Date(t).getDate() === new Date(now).getDate()) return 'today';
  if (diffMs < 2 * day) return 'yesterday';
  if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function modelClass(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return '';
}

export function modelShort(model: string): string {
  // claude-opus-4-7 → opus-4.7, claude-sonnet-4-6 → sonnet-4.6, sonnet → sonnet
  const m = model.replace(/^claude-/, '').replace(/^anthropic\//, '');
  return m.replace(/-(\d+)-(\d+)/, '-$1.$2');
}
