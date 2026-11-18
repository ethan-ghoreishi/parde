export class NetError extends Error {}

const WIKIMEDIA = /(^|\.)(wikipedia|wikidata)\.org$/;

/** JSON GET with a timeout. Wikimedia asks browser clients to identify themselves. */
export async function getJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const headers: Record<string, string> = {};
  if (WIKIMEDIA.test(new URL(url).hostname)) {
    headers['Api-User-Agent'] = 'Parde/1 (personal film diary; https://github.com/ethan-ghoreishi/parde)';
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
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
