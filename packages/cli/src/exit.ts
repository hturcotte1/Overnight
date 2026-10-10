// How the `overnight` process ends once its command has finished.
//
// Normally Node ends by itself, with everything printed delivered. The forced exit below is only
// a backstop for a process something is still holding open (a stray timer or child process):
// launchd would count a hung listener as running and never restart it.
//
// The backstop must not cut output short. When standard output is a pipe and the reader is slow,
// Node still holds what it could not hand over yet, and process.exit() throws that away: the
// reader would get the first 64 KiB of a JSON array and an exit code of 0. So the countdown
// starts only once each stream has handed over everything written to it.

/** The part of a Node stream this needs. process.stdout and process.stderr both fit. */
export interface Flushable {
  /** Bytes written but not yet handed to the operating system. */
  readonly writableLength: number;
  write(chunk: string, callback: (error?: Error | null) => void): unknown;
}

export interface ExitOptions {
  /** How long a process that should have ended by itself is given. Default 3 seconds. */
  graceMs?: number;
  streams?: readonly Flushable[];
  exit?: (code: number) => void;
}

export const EXIT_GRACE_MS = 3000;

export function exitOnceFlushed(code: number, options: ExitOptions = {}): void {
  const graceMs = options.graceMs ?? EXIT_GRACE_MS;
  const streams = options.streams ?? [process.stdout, process.stderr];
  const exit = options.exit ?? ((status: number) => process.exit(status));

  const startCountdown = () => {
    // unref: this timer alone never keeps the process alive.
    setTimeout(() => exit(code), graceMs).unref();
  };
  const holdingOutput = streams.filter((stream) => stream.writableLength > 0);
  if (holdingOutput.length === 0) {
    startCountdown();
    return;
  }
  let waiting = holdingOutput.length;
  for (const stream of holdingOutput) {
    // Writes are delivered in order, so this empty one is called back only after everything
    // before it has gone (or the stream has failed, which ends the wait just the same).
    stream.write("", () => {
      waiting -= 1;
      if (waiting === 0) startCountdown();
    });
  }
}
