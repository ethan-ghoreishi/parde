/** App-wide UI state: toasts and the add dialog. */
export const ui = $state({
  toast: null as null | { text: string; tone: 'ok' | 'error'; action?: { label: string; run: () => void } },
  searchOpen: false,
  searchQuery: '',
  /** The collection cannot be read (storage closed or blocked): say so rather than show an empty page */
  storageError: '',
});

/** The time pages compute "today" and "out yet" from; App moves it on (and on return to the app). */
export const clock = $state({ now: Date.now() });

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, tone: 'ok' | 'error' = 'ok', action?: { label: string; run: () => void }) {
  ui.toast = { text, tone, action };
  clearTimeout(timer);
  timer = setTimeout(() => (ui.toast = null), action ? 10000 : 4000);
}

/** An Undo in a toast: says so if it could not. */
export const undoable = (text: string, undo: () => Promise<void>) =>
  toast(text, 'ok', { label: 'Undo', run: () => undo().then(() => toast('Undone'), (e) => toast(`Not undone: ${errorText(e)}`, 'error')) });

export function errorText(e: unknown) {
  const err = e as { name?: string; inner?: { name?: string }; message?: string } | undefined;
  if (err?.name === 'QuotaExceededError' || err?.inner?.name === 'QuotaExceededError') return 'This device has no space left for Parde. Free some space, then try again.';
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export async function copy(text: string, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Could not copy. Select the text and copy it yourself.', 'error');
  }
}
