/** Hash routing: works on GitHub Pages without server rewrites, and offline. */
function parse() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

export const route = $state(parse());

addEventListener('hashchange', () => {
  Object.assign(route, parse());
  scrollTo(0, 0);
});

export const go = (to: string) => {
  location.hash = to;
};

export const titleHref = (id: string) => `#/t/${encodeURIComponent(id)}`;
/** A person by Wikidata id when known, else by name (TVmaze cast have no Wikidata id). */
export const personHref = (qid: string | undefined, name: string) => `#/p?${new URLSearchParams(qid ? { q: qid, name } : { name })}`;
