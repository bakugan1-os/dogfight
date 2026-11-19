// `catch (error)` gives `unknown` (useUnknownInCatchVariables): anything can be thrown in
// JavaScript — an Error, a string, undefined. These helpers read it without pretending.

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** Node system errors carry a string `code` ("ENOENT", "EADDRINUSE"…). */
export function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
