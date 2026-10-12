// Is there real internet? One small question, asked before a night run starts.
//
// A Mac that has just woken can be on a network with no way out (a hotel's sign-in page, Wi-Fi
// that has not joined yet). A build started then cannot reach Kiro, and both builders failing to
// start fails the idea for good; a delivery started then fails its publish for good. So a due run
// waits until GitHub answers. GitHub, because the morning needs it anyway.
//
// The request carries no login and nothing about the user, and what comes back is not read.

export const ONLINE_CHECK_URL = "https://api.github.com/";
/** A network that works answers in well under a second. */
export const ONLINE_TIMEOUT_MS = 5_000;

/**
 * One HEAD request to GitHub. Any HTTP answer at all is "yes", whatever it says; an error, or no
 * answer in time, is "no". Never throws.
 */
export async function isOnline(options: { fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(ONLINE_CHECK_URL, {
      method: "HEAD",
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(options.timeoutMs ?? ONLINE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
