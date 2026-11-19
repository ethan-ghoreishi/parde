import type { Episode, Title } from './db';
import { code } from './schedule';
import { EXPECTATIONS, criticScore, referenceText, makerAffinity, rated, mean, beforeWatching } from './taste';

/** Reflection questions that work for almost anything; three are offered per title. */
export const QUESTIONS = [
  'What did it want you to believe about people, and do you?',
  'Which choice by a character would you defend that others might not?',
  'What was left unsaid, and why might that have been deliberate?',
  'Whose point of view was missing?',
  'What image or moment will you still remember in a year?',
  'Did it earn its ending, or did it just stop?',
  'What would change if it were set fifty years earlier or later?',
  'Where did your sympathies shift, and what caused it?',
  'What question does it leave you with about your own life?',
  'Was the form (pace, framing, sound) saying something the story was not?',
  'Which character is most like someone you know, and how?',
  'If it is about one idea, what is that idea in a sentence?',
];

export function questionsFor(id: string, n = 3): string[] {
  let h = 0;
  for (const c of id) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: n }, (_, i) => QUESTIONS[(h + i * 5) % QUESTIONS.length]);
}

const makers = (t: Title) => t.people.filter((p) => p.role === 'director' || p.role === 'creator').map((p) => p.name).slice(0, 2).join(' and ');
const what = (t: Title) => `${t.name}${t.year ? ` (${t.year})` : ''}${makers(t) ? `, ${t.kind === 'film' ? 'directed' : 'created'} by ${makers(t)}` : ''}`;

/** Theme words from a pasted line like "Themes: memory; grief" (the review prompt asks for one). */
export const parseThemes = (s: string) => [
  ...new Set(
    s
      .replace(/^\s*themes?\s*:/i, '')
      .split(/[;,\n]/)
      .map((x) => x.trim().toLowerCase().replace(/\.$/, ''))
      .filter((x) => x && x.length <= 40),
  ),
];

/**
 * What you have said about it, as plain statements an assistant can work from. Nothing invented, and
 * nobody else's name: your partner is "my partner".
 */
function yourView(t: Title, library: Title[]): string[] {
  const lines: string[] = [];
  if (t.rating) lines.push(`My rating: ${t.rating}/10${t.partnerRating ? ` (my partner: ${t.partnerRating}/10)` : ''}.`);
  if (t.expectation && beforeWatching(t)) {
    const exp = (t.expectation - 1) * 25;
    const got = t.rating ? (t.rating - 1) * (100 / 9) : undefined;
    const verdict = got === undefined ? '' : got - exp >= 25 ? ' It turned out better than I expected.' : exp - got >= 25 ? ' It fell short of that.' : ' It was about what I expected.';
    lines.push(`After the trailer I was "${EXPECTATIONS[t.expectation].toLowerCase()}".${verdict}`);
  }
  if (t.themes?.length) lines.push(`What it was about for me: ${t.themes.join(', ')}.`);
  if (t.note?.trim()) lines.push(`My notes:\n"""\n${t.note.trim()}\n"""`);
  const others = rated(library.filter((x) => x.id !== t.id));
  if (others.length >= 5 && t.rating) lines.push(`For calibration: I rate things ${mean(others.map((x) => x.rating!)).toFixed(1)}/10 on average.`);
  const makers = new Map(makerAffinity(others, 2).map((a) => [a.key, a]));
  for (const p of t.people.filter((p) => p.role === 'director' || p.role === 'creator')) {
    const a = makers.get(p.name);
    if (a) lines.push(`I have rated ${a.n} other titles by ${p.name}, ${a.avg.toFixed(1)}/10 on average (${a.titles.slice(0, 3).join(', ')}).`);
  }
  const cs = criticScore(t);
  if (cs?.kind === 'critics') lines.push(`Critics, for reference only: ${referenceText(cs)}.`);
  return lines;
}

export interface ReviewOptions {
  length: 'short' | 'full';
  spoilers: boolean;
}

/**
 * A prompt that turns a rating, a few theme words and rough notes into a review in your own voice.
 * It forbids invented opinions and asks for inferences to be marked, so the draft stays yours.
 */
export function reviewPrompt(t: Title, library: Title[], o: ReviewOptions): string {
  const view = yourView(t, library);
  return [
    `Write a review of ${what(t)} in my voice, as if I wrote it myself.`,
    view.length ? view.join('\n') : 'I have not noted anything yet: ask me three short questions about my reaction before writing anything.',
    [
      'Rules:',
      '- Use only the reactions above. Do not invent opinions, praise or criticism I did not give.',
      '- Where you have to infer something to make it read well, put that part in [square brackets] so I can check it.',
      `- ${o.spoilers ? 'Spoilers are fine.' : 'No spoilers beyond the basic setup.'}`,
      `- ${o.length === 'short' ? 'Three to five sentences, first person, conversational, like a Letterboxd review. No headings.' : '300–450 words, first person, with a one-line verdict at the end. No headings.'}`,
      '- Plain, specific language; no clichés like "a must-watch" or "a rollercoaster".',
    ].join('\n'),
    'After the review, add one last line suggesting up to three themes it was really about for me, exactly in the form: Themes: one; two; three',
  ].join('\n\n');
}

export function reflectPrompt(t: Title, library: Title[] = []): string {
  return [
    `I just watched ${what(t)}.`,
    ...yourView(t, library),
    `Help me think about it more deeply: offer two or three distinct interpretations (including one I probably have not considered), the philosophical questions it raises, and where it sits among related works. Spoilers are fine. Challenge my reading where it seems thin. Keep it conversational and end with one question back to me.`,
  ].filter(Boolean).join('\n\n');
}

export function recapPrompt(t: Title, last: Episode): string {
  return [
    `Give me a spoiler-safe recap of the series ${what(t)}, up to and including ${code(last)}${last.name ? ` "${last.name}"` : ''}.`,
    `Strict rule: say nothing about anything that happens after that episode — no hints, foreshadowing or "this becomes important later".`,
    `Cover where each main character stands, the open questions, and the key relationships, in under 300 words.`,
  ].join('\n\n');
}

/**
 * A new, empty chat. The prompt goes by the clipboard, not in the address: an address with your notes in
 * it is kept in browser history and server logs, long ones break, and some assistants send a prefilled
 * prompt before you have read it.
 */
export const ASSISTANTS = { claude: 'https://claude.ai/new', chatgpt: 'https://chatgpt.com/' } as const;
