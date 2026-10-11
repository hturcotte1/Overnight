// The folder name a built app is published under: https://<user>.github.io/<repo>/<slug>/.
// Pure: the caller says which names are taken.

export const SLUG_MIN_CHARS = 3;
export const SLUG_MAX_CHARS = 40;
/** Used when a title has no letters or digits at all. */
export const FALLBACK_SLUG = "app";
/** After this many taken names something is wrong with `isTaken`; stop instead of looping forever. */
const MAX_TRIES = 10_000;

/** Lowercase a-z, 0-9 and single dashes, no dash at either end. May be empty. */
function plainSlug(title: string): string {
  return (
    title
      // "Café" becomes "Cafe": split letters from their accents, then drop the accents.
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

function cut(slug: string, maxChars: number): string {
  return slug.slice(0, maxChars).replace(/-+$/, "");
}

/**
 * A slug for `title`: lowercase a-z, 0-9 and dashes, 3 to 40 characters, never empty.
 * If the name is taken, "-2", "-3", ... is added (the name is shortened to make room).
 */
export function slugFor(title: string, isTaken: (slug: string) => boolean): string {
  let base = cut(plainSlug(title), SLUG_MAX_CHARS);
  if (base === "") base = FALLBACK_SLUG;
  // Too short to stand alone ("qi"): keep it, behind the fallback word.
  else if (base.length < SLUG_MIN_CHARS) base = `${FALLBACK_SLUG}-${base}`;

  if (!isTaken(base)) return base;
  for (let n = 2; n < MAX_TRIES; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${cut(base, SLUG_MAX_CHARS - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`Could not find a free name for the app after ${MAX_TRIES} tries.`);
}

/** Is this already a well-formed slug? Used before trusting one that was stored earlier. */
export function isSlug(value: string): boolean {
  return value.length >= SLUG_MIN_CHARS && value.length <= SLUG_MAX_CHARS && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
