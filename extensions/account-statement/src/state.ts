import type { ActivityItem, StatementSummary } from '@dsg/contracts';
import { ApiError, PAGE_SIZE, type Api, type ActivityQuery } from '@dsg/account-client';

export type Status = 'loading' | 'loaded' | 'error';

export interface StatementState {
  status: Status;
  error: { kind: ApiError['kind']; message: string } | null;
  summary: StatementSummary | null;
  items: ActivityItem[];
  nextCursor: string | null;
  filters: { type: ActivityQuery['type']; from: string; to: string; search: string };
  loadingMore: boolean;
  /** Error from the last pagination/refilter attempt that left existing rows in place. */
  moreError: string | null;
  pdfError: string | null;
  /**
   * A freshly minted single-use PDF link. The UI renders it as a visible "Open PDF" link the user clicks
   * (a real user gesture; no popup/window.open dependence). Cleared on the next request or via clearPdf().
   */
  pdfLink: { url: string; expiresAt: string; label: string; forId?: string } | null;
  /** Invoice id whose PDF link is being prepared. */
  pdfBusyId: string | null;
}

const initial = (): StatementState => ({
  status: 'loading', error: null, summary: null, items: [], nextCursor: null,
  filters: { type: '', from: '', to: '', search: '' }, loadingMore: false, moreError: null, pdfError: null, pdfLink: null, pdfBusyId: null,
});

const toErr = (e: unknown) =>
  e instanceof ApiError ? { kind: e.kind, message: e.message } : { kind: 'unknown' as const, message: 'Something went wrong.' };

export function createStatementStore(api: Api) {
  let state = initial();
  let seq = 0; // discards responses from superseded loads
  const listeners = new Set<() => void>();
  const set = (patch: Partial<StatementState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const q = (cursor: string | null = null): ActivityQuery => ({
    type: state.filters.type, from: state.filters.from, to: state.filters.to, search: state.filters.search, cursor, limit: PAGE_SIZE,
  });

  async function load() {
    const my = ++seq;
    set({ status: 'loading', error: null, items: [], nextCursor: null, moreError: null });
    try {
      const [summary, page] = await Promise.all([api.summary(), api.activity(q())]);
      if (my !== seq) return;
      set({ status: 'loaded', summary, items: page.items, nextCursor: page.nextCursor });
    } catch (e) {
      if (my !== seq) return;
      set({ status: 'error', error: toErr(e) });
    }
  }

  async function refetchActivity() {
    const my = ++seq;
    set({ loadingMore: true, moreError: null, items: [], nextCursor: null });
    try {
      const page = await api.activity(q());
      if (my !== seq) return;
      set({ items: page.items, nextCursor: page.nextCursor, loadingMore: false });
    } catch (e) {
      if (my !== seq) return;
      set({ loadingMore: false, moreError: toErr(e).message });
    }
  }

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    const my = seq;
    set({ loadingMore: true, moreError: null });
    try {
      const page = await api.activity(q(state.nextCursor));
      if (my !== seq) return;
      set({ items: [...state.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false });
    } catch (e) {
      if (my !== seq) return;
      set({ loadingMore: false, moreError: toErr(e).message });
    }
  }

  function setFilters(f: Partial<StatementState['filters']>) {
    set({ filters: { ...state.filters, ...f } });
    return refetchActivity();
  }

  // Step 1 of 2: mint the link. Step 2 is the user clicking the rendered link (see StatementPage).
  async function preparePdf(label: string, get: () => Promise<{ url: string; expiresAt: string }>, forId?: string) {
    set({ pdfError: null, pdfLink: null, pdfBusyId: forId ?? null });
    try {
      const l = await get();
      set({ pdfLink: { url: l.url, expiresAt: l.expiresAt, label, ...(forId ? { forId } : {}) }, pdfBusyId: null });
    } catch (e) {
      set({ pdfError: toErr(e).message, pdfBusyId: null });
    }
  }
  const downloadInvoice = (id: string) => preparePdf('Invoice PDF', () => api.invoicePdfLink(id), id);
  const downloadStatement = () =>
    preparePdf('Statement PDF', () => api.statementPdfLink({ from: state.filters.from || undefined, to: state.filters.to || undefined }));
  const clearPdf = () => set({ pdfLink: null, pdfError: null });

  return {
    getState: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    load, loadMore, setFilters, downloadInvoice, downloadStatement, clearPdf,
  };
}
export type StatementStore = ReturnType<typeof createStatementStore>;
