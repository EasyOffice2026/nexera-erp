import type { Session } from '@nexera/shared';

// The signed-in session lives in memory only. The access token is never written to storage, so
// a script injected into the page cannot read it later. A reload gets a new one from the cookie.
type Listener = () => void;

let session: Session | null = null;
const listeners = new Set<Listener>();

export const sessionStore = {
  get: (): Session | null => session,

  set: (next: Session | null): void => {
    session = next;
    for (const listener of listeners) listener();
  },

  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
