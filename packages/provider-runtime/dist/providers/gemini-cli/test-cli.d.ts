/**
 * Gemini CLI smoke test — spawn `<geminiPath> --version` to verify the
 * binary path is correct and the CLI is executable. Does not require
 * an API key (--version does not call the model).
 *
 * Returns { ok, message } with a user-facing message either way.
 */
declare function testCli(geminiPath: any): Promise<unknown>;
export { testCli };
