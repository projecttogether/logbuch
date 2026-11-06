// Runs once when the server starts. Invalid configuration stops the process
// instead of failing later on the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateWebConfig } = await import("@/lib/config");
    validateWebConfig();
  }
}
