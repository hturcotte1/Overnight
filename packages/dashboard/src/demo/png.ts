// A very small PNG writer: flat rectangles on a plain background, and nothing else.
// The demo's "screenshots" are drawn with it, so no picture of a real app is ever needed, and no
// picture file is kept in the repo. Pure: numbers in, bytes out.
import { crc32, deflateSync } from "node:zlib";

/** The eight bytes every PNG file starts with. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The longest side drawn. A larger picture would only waste memory: the real screenshots are 1280 wide at most. */
export const MAX_PNG_SIDE = 4096;

export type Rgb = [number, number, number];
export interface PngRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rgb: Rgb;
}

function isWholeNumber(value: number): boolean {
  return Number.isInteger(value);
}

function checkColour(rgb: readonly number[], what: string): void {
  if (rgb.length !== 3 || !rgb.every((part) => isWholeNumber(part) && part >= 0 && part <= 255)) {
    throw new RangeError(`${what} must be three whole numbers from 0 to 255 (red, green, blue).`);
  }
}

/** One piece of a PNG file: its length, its four-letter name, its bytes, and a checksum of name and bytes. */
function chunk(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(name, 4, "latin1");
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, sum]);
}

/**
 * A picture `width` by `height` pixels, filled with `background`, with each rectangle painted on
 * top in the order given. A rectangle that sticks out of the picture is cut at the edge. Throws
 * for a size or a colour that makes no picture.
 */
export function drawPng(width: number, height: number, background: Rgb, rects: ReadonlyArray<PngRect>): Buffer {
  for (const side of [width, height]) {
    if (!isWholeNumber(side) || side < 1 || side > MAX_PNG_SIDE) throw new RangeError(`A picture's sides must be whole numbers from 1 to ${MAX_PNG_SIDE}.`);
  }
  checkColour(background, "The background");
  for (const rect of rects) {
    if (![rect.x, rect.y, rect.w, rect.h].every(isWholeNumber)) throw new RangeError("A rectangle's place and size must be whole numbers.");
    checkColour(rect.rgb, "A rectangle's colour");
  }

  // Each line of the picture is one "no filter" byte, then red, green and blue for every pixel.
  const stride = 1 + width * 3;
  const line = Buffer.alloc(stride);
  for (let x = 0; x < width; x += 1) line.set(background, 1 + x * 3);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) line.copy(pixels, y * stride);

  for (const rect of rects) {
    const left = Math.max(0, rect.x);
    const right = Math.min(width, rect.x + rect.w);
    const top = Math.max(0, rect.y);
    const bottom = Math.min(height, rect.y + rect.h);
    if (left >= right || top >= bottom) continue;
    // Paint the rectangle's first line, then copy that stretch down to its other lines.
    const from = top * stride + 1 + left * 3;
    for (let x = left; x < right; x += 1) pixels.set(rect.rgb, top * stride + 1 + x * 3);
    const stretch = pixels.subarray(from, from + (right - left) * 3);
    for (let y = top + 1; y < bottom; y += 1) stretch.copy(pixels, y * stride + 1 + left * 3);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // eight bits for each of red, green and blue
  header.writeUInt8(2, 9); // colour type 2: red, green, blue, no see-through
  // Bytes 10 to 12 stay 0: the one way of packing, the one way of filtering, not interlaced.
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
