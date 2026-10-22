import type { AccountInfo } from '@dsg/contracts';
import { ApiError, type Api } from '@dsg/account-client';

export type AccountState =
  | { status: 'loading' }
  | { status: 'loaded'; account: AccountInfo }
  | { status: 'error'; error: { kind: ApiError['kind']; message: string } };

const toErr = (e: unknown) =>
  e instanceof ApiError ? { kind: e.kind, message: e.message } : { kind: 'unknown' as const, message: 'Something went wrong.' };

/** Plain store (no UI deps), same shape as the statement page's. */
export function createAccountStore(api: Pick<Api, 'account'>) {
  let state: AccountState = { status: 'loading' };
  let seq = 0; // a late response from a superseded load is dropped
  const listeners = new Set<() => void>();
  const set = (s: AccountState) => { state = s; listeners.forEach((l) => l()); };

  async function load() {
    const my = ++seq;
    set({ status: 'loading' });
    try {
      const account = await api.account();
      if (my === seq) set({ status: 'loaded', account });
    } catch (e) {
      if (my === seq) set({ status: 'error', error: toErr(e) });
    }
  }
  return { getState: () => state, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)), load };
}
export type AccountStore = ReturnType<typeof createAccountStore>;
