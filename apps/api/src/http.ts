import type { ZodTypeAny, z } from "zod";
import { ApiError } from "./errors";

/** Parse request data with zod, mapping failures to the contract's BAD_REQUEST error. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new ApiError("BAD_REQUEST", "Invalid request", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

/** Cursor pagination over `id`: fetch limit+1, trim, and return the last kept id as nextCursor. */
export function page<T extends { id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1]!.id };
}
