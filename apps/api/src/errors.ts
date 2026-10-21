/** Error shape from docs/openapi.yaml: `{ code, message, details? }`. */
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "NOT_PURCHASABLE"
  | "VERSION_MISMATCH"
  | "NOT_EDITABLE"
  | "FLOOR_APPROVAL_REQUIRED"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  NOT_PURCHASABLE: 409,
  VERSION_MISMATCH: 409,
  NOT_EDITABLE: 409,
  FLOOR_APPROVAL_REQUIRED: 422,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.httpStatus = STATUS[code];
  }
  toBody() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export const notFound = (what = "Quote") => new ApiError("NOT_FOUND", `${what} not found`);
