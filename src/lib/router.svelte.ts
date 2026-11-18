/** Hash routing: works on GitHub Pages without server rewrites, and offline. */
function parse() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

export const route = $state(parse());

addEventListener('hashchange', () => {
  Object.assign(route, parse());
  window.scrollTo(0, 0);
});

export const go = (to: string) => {
  location.hash = to;
};

export const titleHref = (id: string) => `#/t/${encodeURIComponent(id)}`;
