import type { ProtectedPath, ProtectedCommand } from "./types";
declare const DEFAULT_PROTECTED_PATHS: ProtectedPath[];
declare const DEFAULT_PROTECTED_COMMANDS: ProtectedCommand[];
declare const PACKAGE_INSTALL_COMMAND_PATTERNS: string[];
declare const PROTECTED_CATEGORIES: {
    "modifies-gryphon": string;
    "modifies-editor": string;
    "runs-arbitrary-code": string;
    "escalates-privileges": string;
    "accesses-system": string;
    "persistent-execution": string;
    "destructive-operation": string;
    "network-exec": string;
    "network-fetch": string;
    "package-install": string;
    "user-custom": string;
};
export { DEFAULT_PROTECTED_PATHS, DEFAULT_PROTECTED_COMMANDS, PROTECTED_CATEGORIES, PACKAGE_INSTALL_COMMAND_PATTERNS, };
