import { dayKey } from './schedule';

const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** "Today", "Tomorrow", "Yesterday", "Sat 21 Nov" (this year) or "21 Nov 2024". */
export function formatDay(key: string, today = new Date()): string {
  if (!key) return '';
  const t = dayKey(today);
  const d = new Date(`${key}T12:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  const diff = Math.round((d.getTime() - new Date(`${t}T12:00:00`).getTime()) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.getFullYear() === today.getFullYear() ? fmtShort.format(d) : fmt.format(d);
}

export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return '';
  const days = Math.floor((now - Date.parse(iso)) / 864e5);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const y = Math.round(days / 365);
  return `${y} year${y > 1 ? 's' : ''} ago`;
}

export const runtime = (m?: number) => (!m ? '' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
