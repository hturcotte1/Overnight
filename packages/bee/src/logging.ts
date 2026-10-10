// The gateway's promises must not depend on its logger.
//
// A log line is written in the middle of things: after a to-do was created, while a stream is
// being closed. If the logger threw there (a full disk, a broken collector), a created to-do
// would be reported as an error and a closed stream would never say so. So every line goes
// through a guard: a line that cannot be written is lost, and nothing else is.
import type { LogFields, Logger } from "@overnight/core";

type Level = "debug" | "info" | "warn" | "error";

export function neverThrowing(logger: Logger): Logger {
  const guard = (level: Level) => (message: string, fields?: LogFields): void => {
    try {
      logger[level](message, fields);
    } catch {
      // Lost, on purpose.
    }
  };
  return {
    debug: guard("debug"),
    info: guard("info"),
    warn: guard("warn"),
    error: guard("error"),
    child: (fields) => {
      try {
        return neverThrowing(logger.child(fields));
      } catch {
        return neverThrowing(logger);
      }
    },
  };
}
