import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError } from "../api/client";
import { parseRoute, routeHref, type Route } from "../router";

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
  /** Replace the data locally (after a mutation that returns the new state). */
  set: (next: T) => void;
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(0, "UNKNOWN", err instanceof Error ? err.message : "Something went wrong");
}

/** Run `load` on mount and whenever `deps` change; ignores results from superseded runs. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const run = useRef(0);

  useEffect(() => {
    const id = ++run.current;
    setLoading(true);
    load().then(
      (value) => {
        if (id !== run.current) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (err: unknown) => {
        if (id !== run.current) return;
        setError(toApiError(err));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((next: T) => {
    run.current++; // drop any in-flight load so it cannot overwrite this newer value
    setData(next);
    setError(undefined);
    setLoading(false);
  }, []);
  return { data, error, loading, reload, set };
}

/** Run an async action with a busy flag and an error. */
export function useAction() {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    setError(undefined);
    try {
      return await fn();
    } catch (err) {
      setError(toApiError(err));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, []);

  return { busy, error, run, clearError: () => setError(undefined) };
}

export function go(route: Route): void {
  navigation.navigate(routeHref(route));
}

/** Current in-extension route, updated on every Navigation API entry change. */
export function useRoute(): Route {
  const [url, setUrl] = useState<string | null | undefined>(navigation.currentEntry?.url);
  useEffect(() => {
    const onChange = () => setUrl(navigation.currentEntry?.url);
    navigation.addEventListener("currententrychange", onChange);
    return () => navigation.removeEventListener("currententrychange", onChange);
  }, []);
  return parseRoute(url);
}
