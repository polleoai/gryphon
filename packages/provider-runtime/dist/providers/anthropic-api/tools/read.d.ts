/**
 * Read tool — returns file contents with optional line offset/limit.
 *
 * Schema mirrors Claude Code's built-in Read tool so model behavior is
 * consistent across CLI and Anthropic API modes. Output format also mirrors CC's
 * (line-numbered with `cat -n` style) — the model has been trained on
 * this format, so reproducing it gives better tool-use behavior.
 */
export {};
