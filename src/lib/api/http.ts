export class NetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// Wikimedia asks clients for at most 3 concurrent requests (and limits browsers to ~200 a minute).
const WIKIMEDIA = /(^|\.)(wikipedia|wikidata|wikimedia)\.org$/;
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(host: string, run: () => Promise<T>): Promise<T> {
  if (!WIKIMEDIA.test(host)) return run();
  while (active >= 3) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await run();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON GET with a timeout. No custom headers: they would add a CORS preflight to every request.
 * `retries` (for background work like imports) waits and retries when a service says it is busy.
 */
export async function getJson<T>(url: string, timeoutMs = 15000, retries = 0): Promise<T> {
  const host = new URL(url).hostname;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await slot(host, () => fetch(url, { signal: AbortSignal.timeout(timeoutMs) }));
    } catch (e) {
      throw new NetError(navigator.onLine === false ? 'You are offline.' : `Could not reach ${host}.`, undefined, { cause: e });
    }
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const after = Number(res.headers.get('Retry-After'));
      await sleep(Math.min(60, Number.isFinite(after) && after > 0 ? after : 5 * 2 ** attempt) * 1000);
      continue;
    }
    if (res.status === 429) throw new NetError(`${host} is busy (too many requests). Try again in a minute.`, 429);
    if (!res.ok) throw new NetError(`${host} replied ${res.status}.`, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch (e) {
      // A sign-in page on public Wi-Fi, a proxy, a cut-off reply.
      throw new NetError(`${host} sent something unreadable. Check your connection.`, undefined, { cause: e });
    }
    // MediaWiki reports failures with a 200: without this they look like "nothing found".
    const err = WIKIMEDIA.test(host) ? (body as { error?: { code?: string } } | null)?.error : undefined;
    if (err) {
      const busy = /^(maxlag|ratelimited|readonly)$/.test(err.code ?? '');
      if (busy && attempt < retries) {
        await sleep(5000 * 2 ** attempt);
        continue;
      }
      throw new NetError(busy ? `${host} is busy. Try again in a minute.` : `${host} could not answer (${err.code ?? 'error'}).`, busy ? 429 : undefined);
    }
    return body as T;
  }
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
