import { tick } from 'svelte';

/** Hash routing: works on GitHub Pages without server rewrites, and offline. */
function parse() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

export const route = $state(parse());

// Each history entry remembers how far down it was, so Back returns to the same place in a long library.
history.scrollRestoration = 'manual';
let saving: ReturnType<typeof setTimeout> | undefined;
addEventListener('scroll', () => {
  clearTimeout(saving);
  saving = setTimeout(() => history.replaceState({ y: scrollY }, ''), 200);
}, { passive: true });

let letGo = () => {};
/** Pages fill in from storage over several steps, above the place too: hold it until they settle, or you move. */
function scrollBack(y: number) {
  letGo();
  scrollTo(0, y);
  if (!y) return;
  const grows = new ResizeObserver(() => scrollTo(0, y));
  grows.observe(document.body);
  const moves = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  const timer = setTimeout(() => letGo(), 1000);
  letGo = () => {
    clearTimeout(timer);
    grows.disconnect();
    for (const m of moves) removeEventListener(m, letGo);
    letGo = () => {};
  };
  for (const m of moves) addEventListener(m, letGo, { passive: true });
}

// A reload stays where it was, too.
const startY = (history.state as { y?: number } | null)?.y;
if (startY) tick().then(() => scrollBack(startY));

addEventListener('hashchange', () => {
  clearTimeout(saving);
  const moved = parse().path !== route.path;
  Object.assign(route, parse());
  // Once the new page has replaced the old one, whose height says nothing about it.
  const y = (history.state as { y?: number } | null)?.y ?? 0;
  tick().then(() => scrollBack(y));
  // A new page, not just a filter: keyboard and screen reader users start at its top.
  if (moved) document.getElementById('main')?.focus({ preventScroll: true });
});

export const go = (to: string) => {
  location.hash = to;
};

export const titleHref = (id: string) => `#/t/${encodeURIComponent(id)}`;
/** A person by Wikidata id when known, else by name (TVmaze cast have no Wikidata id). */
export const personHref = (qid: string | undefined, name: string) => `#/p?${new URLSearchParams(qid ? { q: qid, name } : { name })}`;
