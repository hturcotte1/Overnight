// Reads the one result line our contract test prints (harness/contract.spec.ts) and decides
// whether the page may be published. Pure: no clock, no files, no logging.
import { z } from "zod";
import type { VerifyChecks } from "./types.ts";

/** The start of the result line. Keep in step with MARKER in harness/contract.spec.ts. */
export const CONTRACT_MARKER = "OVERNIGHT_CONTRACT ";

const count = z.number().int().min(0);

const viewSchema = z.strictObject({
  loaded: z.boolean(),
  status: count,
  headingVisible: z.boolean(),
  visibleTextChars: count,
  /** -1 when it could not be measured. */
  overflowPx: z.number().int().min(-1),
  requests: count,
  nonLocalRequests: count,
  failedRequests: count,
  consoleErrors: count,
  pageErrors: count,
  screenshot: z.boolean(),
  ms: z.number().min(0),
});

const measureSchema = z.strictObject({ phone: viewSchema, desktop: viewSchema });

export type ViewMeasure = z.infer<typeof viewSchema>;
export type ContractMeasure = z.infer<typeof measureSchema>;

/** The measurements from the test's output, or null if the line is missing or not what we print. */
export function parseContractOutput(stdout: string): ContractMeasure | null {
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => text.startsWith(CONTRACT_MARKER));
  if (line === undefined) return null;
  try {
    const parsed = measureSchema.safeParse(JSON.parse(line.slice(CONTRACT_MARKER.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What is wrong with one view, in plain words, without saying which screen. */
function viewProblems(view: ViewMeasure): string[] {
  if (!view.loaded) return ["the page did not load"];
  const problems: string[] = [];
  if (!view.headingVisible && view.visibleTextChars === 0) problems.push("nothing is visible");
  if (view.nonLocalRequests > 0) problems.push(`${plural(view.nonLocalRequests, "request", "requests")} to somewhere other than its own files`);
  if (view.failedRequests > 0) problems.push(plural(view.failedRequests, "failed request", "failed requests"));
  if (view.consoleErrors + view.pageErrors > 0) problems.push(plural(view.consoleErrors + view.pageErrors, "console error", "console errors"));
  if (!view.screenshot) problems.push("no screenshot could be taken");
  return problems;
}

export interface ContractVerdict {
  ok: boolean;
  /** Plain words, counts only. Empty when ok. */
  problems: string[];
  checks: VerifyChecks;
}

/**
 * The app contract's page checks (SPEC §6): it loads, shows a heading or other content, has a
 * clean console, loads every one of its files, talks to nobody else, and fits a 390x844 phone.
 */
export function judgeContract(measure: ContractMeasure, options: { phoneOverflowAllowedPx: number }): ContractVerdict {
  const onPhone = viewProblems(measure.phone);
  const onDesktop = viewProblems(measure.desktop);
  // The same trouble on both screens is said once.
  const sameOnBoth = onPhone.length > 0 && onPhone.join("|") === onDesktop.join("|");
  const problems = sameOnBoth
    ? onPhone.map((problem) => `${problem} on both screen sizes`)
    : [...onPhone.map((problem) => `${problem} on a phone-sized screen`), ...onDesktop.map((problem) => `${problem} on a desktop-sized screen`)];
  const fitsPhone = measure.phone.overflowPx >= 0 && measure.phone.overflowPx <= options.phoneOverflowAllowedPx;
  if (measure.phone.loaded && !fitsPhone) {
    problems.push(measure.phone.overflowPx < 0 ? "the page's width on a phone could not be measured" : `the page is ${measure.phone.overflowPx} pixels wider than a phone screen`);
  }
  const checks: VerifyChecks = { phoneFits: fitsPhone };
  for (const [name, view] of [
    ["phone", measure.phone],
    ["desktop", measure.desktop],
  ] as const) {
    checks[`${name}Loaded`] = view.loaded;
    checks[`${name}HeadingVisible`] = view.headingVisible;
    checks[`${name}VisibleTextChars`] = view.visibleTextChars;
    checks[`${name}OverflowPx`] = view.overflowPx;
    checks[`${name}Requests`] = view.requests;
    checks[`${name}NonLocalRequests`] = view.nonLocalRequests;
    checks[`${name}FailedRequests`] = view.failedRequests;
    checks[`${name}ConsoleErrors`] = view.consoleErrors;
    checks[`${name}PageErrors`] = view.pageErrors;
    checks[`${name}Screenshot`] = view.screenshot;
    checks[`${name}Ms`] = Math.round(view.ms);
  }
  return { ok: problems.length === 0, problems, checks };
}
