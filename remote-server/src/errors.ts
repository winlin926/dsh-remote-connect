/** HTTP/WSS-facing error type. Every route failure is mapped to a stable code. */

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | undefined

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message)
  }

  static unauthorized(code: string, message: string): ApiError {
    return new ApiError(401, code, message)
  }

  static forbidden(code: string, message: string): ApiError {
    return new ApiError(403, code, message)
  }

  static notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message)
  }

  static methodNotAllowed(message = 'Method not allowed.'): ApiError {
    return new ApiError(405, 'METHOD_NOT_ALLOWED', message)
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message)
  }

  static gone(code: string, message: string): ApiError {
    return new ApiError(410, code, message)
  }

  static payloadTooLarge(code: string, message: string): ApiError {
    return new ApiError(413, code, message)
  }

  static tooManyRequests(code: string, message: string, retryAfterMs?: number): ApiError {
    return new ApiError(429, code, message, retryAfterMs)
  }

  static notImplemented(code: string, message: string): ApiError {
    return new ApiError(501, code, message)
  }

  static internal(message = 'Internal server error.'): ApiError {
    return new ApiError(500, 'INTERNAL', message)
  }
}

export function rateLimited(retryAfterMs: number): ApiError {
  return new ApiError(429, 'RATE_LIMITED', 'Too many requests; retry later.', retryAfterMs)
}

export interface ErrorBody {
  error: { code: string; message: string; retryable?: boolean }
}

export function errorBody(code: string, message: string, retryable?: boolean): ErrorBody {
  return { error: retryable === undefined ? { code, message } : { code, message, retryable } }
}
