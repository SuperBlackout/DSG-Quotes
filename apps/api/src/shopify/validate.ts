import { buildClientSchema, buildSchema, parse, validate, type GraphQLSchema, type IntrospectionQuery } from "graphql";

/** Accepts SDL, `{ data: { __schema } }` or `{ __schema }` introspection JSON. */
export function loadSchema(text: string): GraphQLSchema {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(text) as { data?: IntrospectionQuery } & Partial<IntrospectionQuery>;
    const introspection = (json.data ?? json) as IntrospectionQuery;
    return buildClientSchema(introspection);
  }
  return buildSchema(text);
}

export interface ValidationFailure {
  name: string;
  errors: string[];
}

export function validateDocuments(schema: GraphQLSchema, docs: Record<string, string>): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  for (const [name, source] of Object.entries(docs)) {
    try {
      const errors = validate(schema, parse(source));
      if (errors.length) failures.push({ name, errors: errors.map((e) => e.message) });
    } catch (e) {
      failures.push({ name, errors: [(e as Error).message] });
    }
  }
  return failures;
}
