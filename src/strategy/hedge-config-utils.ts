/**
 * Parse a user-provided numeric input string while falling back to the previous value
 * when the string is empty or contains only whitespace.
 *
 * @param raw - The raw input from the user.
 * @param fallback - The value to return when {@link raw} is empty.
 * @returns The parsed number, the fallback when empty, or {@code null} when parsing fails.
 */
export function parseNumericInput(raw: string | undefined | null, fallback: number): number | null {
  if (raw == null) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Determine whether the supplied order amount is valid for hedge configuration.
 * The value must be a finite number greater than zero.
 */
export function isValidOrderAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Determine whether the supplied ROI percent is valid for hedge configuration.
 * The value must be a finite number that is zero or greater.
 */
export function isValidRoiPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

