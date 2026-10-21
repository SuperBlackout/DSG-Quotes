import type { components } from "./api";

export * from "./quote-state";
export * from "./shopify";
export type { paths, components, operations } from "./api";

/** Shorthand: `Schemas["CustomerQuote"]`. Generated from docs/openapi.yaml (`pnpm -F shared gen:types`). */
export type Schemas = components["schemas"];
