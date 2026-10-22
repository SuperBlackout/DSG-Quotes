/** Typed errors for the Zoho client. Messages are always passed through redaction before construction. */
export class ZohoError extends Error {
  constructor(message: string, public readonly status?: number, public readonly zohoCode?: number) {
    super(message);
    this.name = new.target.name;
  }
}
/** Zoho returned a JSON body with `code != 0` (or a non-2xx with a code). */
export class ZohoApiError extends ZohoError {}
export class ZohoNotFoundError extends ZohoApiError {}
export class ZohoAuthError extends ZohoError {}
export class ZohoRateLimitError extends ZohoError {}
export class ZohoServerError extends ZohoError {}
export class ZohoNetworkError extends ZohoError {}
export class ZohoSchemaError extends ZohoError {}
export class ZohoConfigError extends ZohoError {}
/** Thrown when anything other than a GET (or the OAuth token POST) is attempted. */
export class ZohoReadOnlyViolation extends ZohoError {}
