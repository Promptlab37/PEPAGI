// ═══════════════════════════════════════════════════════════════
// PEPAGI TUI — Shared CJS Module Loader
// ═══════════════════════════════════════════════════════════════
//
// Loads blessed (CJS) and blessed-contrib (CJS) once via createRequire
// and re-exports them for all panels/views to import uniformly.
// This avoids duplicating the createRequire call across every file.

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const blessed: any = _require("blessed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const contrib: any  = _require("blessed-contrib");
