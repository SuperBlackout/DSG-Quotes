/** Convert a JS number to integer cents, avoiding binary-float artefacts (1.005 -> 101). */
export function toCents(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) throw new Error('invalid money value');
  const c = Math.round(Math.abs(Number((n * 100).toPrecision(12)))); // half away from zero
  return n < 0 ? -c : c;
}
/** Integer cents -> "123.45" decimal string (safe for numeric(14,2)). */
export function centsToDecimal(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg && abs !== 0 ? `-${s}` : s;
}
/** number -> 2dp decimal string via integer cents. */
export const numToDecimal = (n: number | null | undefined): string => centsToDecimal(toCents(n));
