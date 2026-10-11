// Reading a small text file that something else may have written.
//
// Some of the files the command line looks at sit in folders a build job can write in (Kiro
// Crew's own folder, where the build skill is installed). A plain read of such a file can be
// turned against us: a named pipe in its place makes the read wait for ever, a symbolic link
// points it at some other file, and a huge file fills memory. So: open without following a link
// and without waiting, look at what was actually opened, and read only a plain file of a
// sensible size.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** The file's text, or null if it is missing, not a plain file, a link, or larger than `maxBytes`. Never throws. */
export function readSmallFile(file: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const data = Buffer.alloc(info.size);
    let read = 0;
    while (read < data.length) {
      const count = readSync(fd, data, read, data.length - read, null);
      if (count === 0) break;
      read += count;
    }
    return data.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Same text, whatever the line endings or the blank lines at either end. The rule @overnight/builder uses for the installed skill. */
export function sameText(a: string, b: string): boolean {
  const tidy = (text: string) => text.replace(/\r\n?/g, "\n").trim();
  return tidy(a) === tidy(b);
}
