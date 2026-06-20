/**
 * WebFetch tool — fetch a URL and return its content.
 *
 * Mirrors Claude Code's WebFetch contract. Returns up to MAX_CONTENT_BYTES
 * of decoded body. For HTML, performs minimal cleanup (strip <script>,
 * <style>, collapse whitespace) so the model gets readable text rather
 * than raw markup. PDF / binary content surfaces as an error directing
 * the model to use Read on a local copy if needed.
 *
 * Permission: read-only network operation. Refused only in plan mode;
 * allowed in default / acceptEdits / bypassPermissions without prompt.
 *
 * SSRF hardening (post-v0.2.0):
 *   - `redirect: "manual"` — we follow redirects ourselves so each hop's
 *     hostname/IP gets re-validated. `fetch`'s default `"follow"` silently
 *     chases a 302 → http://127.0.0.1/admin without any re-check.
 *   - DNS pre-resolution with undici.Agent connect pinning — reject any
 *     hostname that resolves to a private/loopback IP, and pin the TCP
 *     connect to the resolved address so DNS rebinding (TTL=0 attacker
 *     DNS that flips from public to 127.0.0.1 between our check and
 *     undici's own resolution) can't bypass the guard.
 */
export {};
