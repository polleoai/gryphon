import { ClaudePassiveSession } from "./claude-passive-session";
import type { PassiveSessionInit } from "./claude-passive-session";
declare function createPassiveSession(config: PassiveSessionInit): Promise<ClaudePassiveSession>;
export { createPassiveSession };
