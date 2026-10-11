// Is the Kiro Crew gateway on this Mac there? One small question, asked of this Mac only.
//
// The gateway is a local program that listens on a port of this Mac (5476 unless KIROCREW_PORT
// says otherwise; our background job does not set it). `kirocrew status` calls it "running" when
// anything answers HTTP there, and so do we: one GET of its health page, which needs no login
// and sends nothing (the Milestone 2 experiments saw it answer 200). No credits, no cloud call.

/** Kiro Crew's own default port. scripts/install-agents.sh uses the same number. */
export const DEFAULT_CREW_PORT = 5476;
/** A gateway that is there answers in a few milliseconds. */
export const GATEWAY_TIMEOUT_MS = 3_000;

/** The port the gateway listens on: KIROCREW_PORT when it is a usable port number, else Kiro Crew's default. */
export function crewPort(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.KIROCREW_PORT ?? "").trim();
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CREW_PORT;
}

/** Does anything answer HTTP where the gateway listens? Never throws: no answer in time is "no". */
export async function gatewayAnswers(options: { port?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {}): Promise<boolean> {
  const port = options.port ?? crewPort();
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? GATEWAY_TIMEOUT_MS) });
    // Whatever it said, something is there. What it said is not kept.
    await response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
