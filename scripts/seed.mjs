// Builds src/data/seed.json: widely known films and series by decade, for Discover before your library says
// anything about you (and offline). Wikidata is CC0. Run rarely: node scripts/seed.mjs
// "Widely known" = how many Wikipedia language editions have an article about it.
import { writeFileSync } from 'node:fs';

async function sparql(query) {
  const res = await fetch(`https://query.wikidata.org/sparql?${new URLSearchParams({ format: 'json', query })}`, { headers: { 'User-Agent': 'seed-script/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results.bindings;
}
const label = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }';
const films = await sparql(`SELECT ?f ?fLabel ?l (MIN(YEAR(?d)) AS ?y) WHERE {
  ?f p:P444/pq:P459 wd:Q108403393; wikibase:sitelinks ?l . FILTER(?l > 30)
  ?f wdt:P31 wd:Q11424; wdt:P577 ?d . ${label} } GROUP BY ?f ?fLabel ?l ORDER BY DESC(?l) LIMIT 4000`);
await new Promise((r) => setTimeout(r, 5000));
const shows = await sparql(`SELECT ?f ?fLabel ?l (MIN(YEAR(?d)) AS ?y) (SAMPLE(?tv) AS ?tvm) WHERE {
  ?f wdt:P31 ?type; wdt:P8600 ?tv; wdt:P580 ?d; wikibase:sitelinks ?l . VALUES ?type { wd:Q5398426 wd:Q1259759 } FILTER(?l > 22)
  ${label} } GROUP BY ?f ?fLabel ?l ORDER BY DESC(?l) LIMIT 1500`);

const PER = { film: { 1930: 12, 1940: 16, 1950: 28, 1960: 36, default: 48 }, show: { 1960: 4, 1970: 6, 1980: 10, default: 24 } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wikidata's start date can be the comic's or the pilot's: TVmaze knows the premiere, and what is not drama or comedy. */
async function premiere(id) {
  await wait(600); // 20 requests per 10 seconds
  const res = await fetch(`https://api.tvmaze.com/shows/${id}`, { headers: { 'User-Agent': 'seed-script/1.0' } });
  if (!res.ok) return undefined;
  const t = await res.json();
  const ok = ['Scripted', 'Animation', 'Documentary'].includes(t.type) && !t.genres.includes('Children') && t.premiered;
  return ok ? Number(t.premiered.slice(0, 4)) : undefined;
}

async function pick(rows, kind) {
  const count = {}, series = {}, seen = new Set(), out = [];
  for (const b of rows) {
    const qid = b.f.value.split('/').pop();
    const name = b.fLabel.value;
    const franchise = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, 2).join(' ');
    if (/^Q\d+$/.test(name) || seen.has(qid) || (kind === 'film' && (series[franchise] ?? 0) >= 2)) continue;
    const cap = (y) => PER[kind][y] ?? (y >= (kind === 'film' ? 1930 : 1960) ? PER[kind].default : 0);
    let year = Number(b.y?.value);
    const decadeOf = (y) => Math.floor(y / 10) * 10;
    if (!year || (count[decadeOf(year)] ?? 0) >= cap(decadeOf(year))) continue;
    seen.add(qid);
    if (kind === 'show') year = await premiere(b.tvm.value);
    if (!year || (count[decadeOf(year)] ?? 0) >= cap(decadeOf(year))) continue;
    series[franchise] = (series[franchise] ?? 0) + 1;
    count[decadeOf(year)] = (count[decadeOf(year)] ?? 0) + 1;
    out.push([Number(qid.slice(1)), name, year, kind === 'show' ? Number(b.tvm.value) : 0]);
  }
  return out;
}
const out = [...(await pick(films, 'film')), ...(await pick(shows, 'show'))];
// The English Wikipedia article (for its poster), only when it is not simply the name, to keep the file small.
for (let i = 0; i < out.length; i += 50) {
  const ids = out.slice(i, i + 50).map((x) => `Q${x[0]}`);
  const q = new URLSearchParams({ action: 'wbgetentities', format: 'json', ids: ids.join('|'), props: 'sitelinks', sitefilter: 'enwiki' });
  const { entities } = await (await fetch(`https://www.wikidata.org/w/api.php?${q}`, { headers: { 'User-Agent': 'seed-script/1.0' } })).json();
  for (const x of out.slice(i, i + 50)) {
    const wiki = entities[`Q${x[0]}`]?.sitelinks?.enwiki?.title;
    if (wiki && wiki !== x[1]) x.push(wiki);
  }
  await wait(1000);
}
writeFileSync('src/data/seed.json', `[\n${out.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
console.log(films.length, shows.length, '→', out.length);
