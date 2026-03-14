/**
 * Fetch with exponential backoff retry.
 *
 * Retries on network errors and 429/5xx responses.
 * Does NOT retry on 4xx (client errors) — those are permanent.
 */
export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 5000) */
  maxDelayMs?: number;
  /** Timeout per request in ms (default: 10000) */
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  timeoutMs: 10000,
};

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok || !isRetryable(res.status)) {
        return res;
      }

      // Retryable HTTP status — wait and try again
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // AbortError from timeout — retryable
      // TypeError from network error — retryable
      if (
        lastError.name !== "AbortError" &&
        lastError.name !== "TypeError" &&
        !(lastError.message.includes("fetch") || lastError.message.includes("network"))
      ) {
        throw lastError;
      }
    }

    if (attempt < opts.maxAttempts) {
      // Exponential backoff with jitter
      const delay = Math.min(
        opts.baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100,
        opts.maxDelayMs
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error("All retry attempts failed");
}
