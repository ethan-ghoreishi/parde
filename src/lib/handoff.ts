import type { Episode, Title } from './db';
import { code } from './schedule';

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

export function reflectPrompt(t: Title): string {
  return [
    `I just watched ${what(t)}.`,
    t.rating ? `I'd rate it ${t.rating}/10.` : '',
    t.note?.trim() ? `My first thoughts:\n"""\n${t.note.trim()}\n"""` : '',
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

export const claudeUrl = (prompt: string) => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
