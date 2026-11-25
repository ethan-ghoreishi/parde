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

function scrollBack(y: number, tries = 40) {
  // Pages fill in from storage a moment after they appear.
  if (y && tries && document.documentElement.scrollHeight < y + innerHeight) requestAnimationFrame(() => scrollBack(y, tries - 1));
  else scrollTo(0, y);
}

addEventListener('hashchange', () => {
  clearTimeout(saving);
  const moved = parse().path !== route.path;
  Object.assign(route, parse());
  scrollBack((history.state as { y?: number } | null)?.y ?? 0);
  // A new page, not just a filter: keyboard and screen reader users start at its top.
  if (moved) document.getElementById('main')?.focus({ preventScroll: true });
});

export const go = (to: string) => {
  location.hash = to;
};

export const titleHref = (id: string) => `#/t/${encodeURIComponent(id)}`;
/** A person by Wikidata id when known, else by name (TVmaze cast have no Wikidata id). */
export const personHref = (qid: string | undefined, name: string) => `#/p?${new URLSearchParams(qid ? { q: qid, name } : { name })}`;
