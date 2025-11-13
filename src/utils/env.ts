/**
 * Normalize raw environment variable values by removing common control characters
 * that appear when files are saved with UTF-16 / BOM encodings (e.g. NUL bytes).
 */
export function sanitizeEnvValue(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const withoutBom = value.replace(/\uFEFF/g, "");
  const withoutNull = withoutBom.replace(/\u0000/g, "");
  const trimmed = withoutNull.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getSanitizedEnv(key: string): string | undefined {
  return sanitizeEnvValue(process.env[key]);
}
