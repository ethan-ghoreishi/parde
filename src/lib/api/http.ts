export class NetError extends Error {}

/** JSON GET with a timeout. No custom headers: they would add a CORS preflight to every request. */
export async function getJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new NetError(navigator.onLine === false ? 'You are offline.' : `Could not reach ${new URL(url).hostname}.`, { cause: e });
  }
  if (res.status === 429) throw new NetError('The metadata service is busy. Try again in a minute.');
  if (!res.ok) throw new NetError(`${new URL(url).hostname} replied ${res.status}.`);
  return (await res.json()) as T;
}

export function qs(params: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

/** TVmaze summaries are HTML. Plain text keeps them inert. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
}
