/** Largest log file the analyzer reads into memory (audit C-9). */
export const MAX_LOG_FILE_BYTES = 200 * 1024 * 1024;

/** Error text for a file over the limit, or null when it may be imported. */
export function logFileSizeError(name: string, sizeBytes: number): string | null {
  if (sizeBytes <= MAX_LOG_FILE_BYTES) return null;
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  return `${name} is ${mb(sizeBytes)} MB; the import limit is ${mb(MAX_LOG_FILE_BYTES)} MB. Split the log and import the parts.`;
}
