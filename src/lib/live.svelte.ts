import { liveQuery } from 'dexie';

/**
 * Reactive Dexie query. `deps` runs inside an effect (so reading $state there re-subscribes);
 * it returns the actual query, which re-runs whenever the tables it read change.
 */
export function live<T>(deps: () => () => Promise<T> | T, initial: T) {
  let value = $state.raw<T>(initial);
  let ready = $state(false);
  $effect(() => {
    const query = deps();
    const sub = liveQuery(query).subscribe({
      next: (v) => {
        value = v;
        ready = true;
      },
      error: (e) => console.error(e),
    });
    return () => sub.unsubscribe();
  });
  return {
    get value() {
      return value;
    },
    get ready() {
      return ready;
    },
  };
}
