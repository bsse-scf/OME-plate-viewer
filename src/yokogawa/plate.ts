/**
 * Naming wells the way OME-Zarr does.
 *
 * The format places a well at `<row>/<column>` — `B/2` — with its fields of
 * view beneath it, and names rows and columns as they are printed on the plate.
 * These are the only two conventions that matter here, so this is all that is
 * left of what was once vendor plate-geometry parsing: wells are laid out by
 * their imaged extent rather than by the physical well pitch, which is decided
 * in `model.ts`.
 */

/** Row name: `A`, `B`, … `Z`, `AA`, for a zero-based row index. */
export function rowName(row: number): string {
  let name = '';
  let remaining = row;
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

/** Column name, which OME-Zarr numbers from one. */
export function columnName(column: number): string {
  return String(column + 1);
}

/** Well name in the usual `A1` / `H12` / `AA3` form. */
export function wellName(row: number, column: number): string {
  return `${rowName(row)}${columnName(column)}`;
}
