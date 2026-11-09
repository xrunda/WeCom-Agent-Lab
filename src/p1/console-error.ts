/** 控制台统一的业务错误：code 与 HTTP 状态按 docs/P1-api.md §1.4 */
export type ConsoleErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'ACCOUNT_DISABLED'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'BUILTIN_RULE'
  | 'IMMUTABLE_RESOURCE'
  | 'METHOD_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'LIMIT_EXCEEDED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ConsoleErrorCode, number> = {
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  BUILTIN_RULE: 409,
  IMMUTABLE_RESOURCE: 409,
  METHOD_NOT_ALLOWED: 405,
  RATE_LIMITED: 429,
  LIMIT_EXCEEDED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  INTERNAL: 500,
};

export class ConsoleError extends Error {
  readonly code: ConsoleErrorCode;
  readonly status: number;
  readonly details?: Array<{ field: string; issue: string }>;

  constructor(
    code: ConsoleErrorCode,
    message: string,
    details?: Array<{ field: string; issue: string }>,
  ) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}
