/** App-wide UI state: toasts and the add dialog. */
export const ui = $state({
  toast: null as null | { text: string; tone: 'ok' | 'error'; action?: { label: string; run: () => void } },
  searchOpen: false,
  searchQuery: '',
});

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, tone: 'ok' | 'error' = 'ok', action?: { label: string; run: () => void }) {
  ui.toast = { text, tone, action };
  clearTimeout(timer);
  timer = setTimeout(() => (ui.toast = null), action ? 7000 : 3500);
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Could not copy. Long-press the link instead.', 'error');
  }
}
