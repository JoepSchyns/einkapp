import { MiddlewareHandler } from 'hono'

interface RetryOptions {
  maxRetries?: number
  delayMs?: number
}

export const retryMiddleware = (options: RetryOptions = {}): MiddlewareHandler => {
  const { maxRetries = 3, delayMs = 300 } = options

  return async (c, next) => {
    let lastError: unknown

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await next()

        // c.res.ok is false for any status outside 200–299
        if (!c.res.ok && attempt < maxRetries) {
          throw new Error(`Request failed with status ${c.res.status}`)
        }

        // Return if request succeeded (2xx) or max retries were reached
        return
      } catch (err) {
        lastError = err

        if (attempt === maxRetries) {
          throw lastError
        }

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
        }
      }
    }
  }
}
