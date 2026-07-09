// Workspace naming — embedded city list + collision-safe allocator.
// Pure: no I/O, no Electron, no DB. Unit-tests run in plain Node.

/**
 * Ordered list of lowercase, single-word, URL/branch-safe city names used as
 * unique workspace identifiers within a project. Names must be single words
 * (no spaces, no special characters beyond ASCII letters) so they are safe as
 * git branch path components and directory names.
 */
export const CITY_NAMES: readonly string[] = [
  'paris',
  'tokyo',
  'cairo',
  'oslo',
  'lima',
  'quito',
  'dubai',
  'seoul',
  'rome',
  'athens',
  'vienna',
  'prague',
  'lisbon',
  'brussels',
  'budapest',
  'warsaw',
  'berlin',
  'nairobi',
  'lagos',
  'accra',
  'tunis',
  'algiers',
  'casablanca',
  'dakar',
  'kigali',
  'mumbai',
  'delhi',
  'bangkok',
  'jakarta',
  'manila',
  'hanoi',
  'taipei',
  'colombo',
  'dhaka',
  'kathmandu',
  'tashkent',
  'almaty',
  'baku',
  'yerevan',
  'tbilisi',
  'bogota',
  'santiago',
  'caracas',
  'asuncion',
  'montevideo',
  'havana',
  'kingston',
  'ottawa',
  'denver',
  'phoenix',
] as const;

/**
 * Allocate the next available workspace name for a project.
 *
 * Strategy:
 * 1. Return the first city in {@link CITY_NAMES} whose base name is not in
 *    `existingNames`.
 * 2. When every base name is taken, scan for the first `<city>-<n>` (n ≥ 2)
 *    that is free, iterating n in the outer loop (so all cities are tried at
 *    suffix `-2` before trying `-3`, etc.). This minimises the numeric suffix
 *    while keeping the city order stable.
 *
 * @param existingNames - The **non-archived** workspace names already in use
 *   for the project (WorkspaceManager derives this from
 *   `WorkspacesRepo.listByProject`). The function never mutates this array.
 * @returns A workspace name guaranteed not to appear in `existingNames`.
 */
export function allocate(existingNames: string[]): string {
  const taken = new Set(existingNames);

  // Phase 1: first free base city name.
  for (const city of CITY_NAMES) {
    if (!taken.has(city)) {
      return city;
    }
  }

  // Phase 2: all base names are taken — find the smallest `<city>-<n>` (n ≥ 2)
  // that is free.  Outer loop is n so that suffix values are minimised across
  // the full city list before incrementing (e.g. try all cities at `-2` before
  // any city at `-3`).
  for (let n = 2; ; n++) {
    for (const city of CITY_NAMES) {
      const candidate = `${city}-${n}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }
}
