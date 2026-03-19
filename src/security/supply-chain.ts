// ═══════════════════════════════════════════════════════════════
// PEPAGI — Supply Chain Security (SEC-26)
// Dependency integrity verification, lockfile checks,
// SBOM generation, and slopsquatting defense.
// ═══════════════════════════════════════════════════════════════

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Logger } from "../core/logger.js";

const logger = new Logger("SupplyChain");

// SECURITY: SEC-26 — Known slopsquatting patterns (AI-hallucinated package names)
const SLOPSQUATTING_PATTERNS = [
  /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+$/,  // Overly specific multi-word packages
  /^(my|the|a|your|this)-/,                  // Unlikely npm prefixes
  /^(super|ultra|mega|best|pro)-(?!framework|linter|test)/i,
];

export interface LockfileCheck {
  exists: boolean;
  hash: string | null;
  valid: boolean;
  error?: string;
}

export interface SBOMEntry {
  name: string;
  version: string;
  pinned: boolean;
  license?: string;
}

export interface SBOMReport {
  projectName: string;
  projectVersion: string;
  generatedAt: string;
  dependencies: SBOMEntry[];
  devDependencies: SBOMEntry[];
  totalDeps: number;
  pinnedCount: number;
  unpinnedCount: number;
}

/**
 * SECURITY: SEC-26 — Check if a version string is pinned (exact version).
 */
export function isVersionPinned(version: string): boolean {
  // Pinned: "1.2.3", not: "^1.2.3", "~1.2.3", ">=1.0.0", "*", "latest"
  return /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version);
}

/**
 * SECURITY: SEC-26 — Check package name for slopsquatting risk.
 * Returns true if the name looks suspicious (possible AI hallucination).
 */
export function checkSlopsquatting(packageName: string): boolean {
  return SLOPSQUATTING_PATTERNS.some(p => p.test(packageName));
}

/**
 * SECURITY: SEC-26 — Verify lockfile integrity.
 * Checks that package-lock.json exists and is consistent.
 */
export async function verifyLockfile(projectRoot: string): Promise<LockfileCheck> {
  const lockPath = join(projectRoot, "package-lock.json");

  try {
    await stat(lockPath);
  } catch {
    return { exists: false, hash: null, valid: false, error: "package-lock.json not found" };
  }

  try {
    const content = await readFile(lockPath, "utf8");
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    // Basic structural validation
    const parsed = JSON.parse(content);
    if (!parsed.lockfileVersion || !parsed.packages) {
      return { exists: true, hash, valid: false, error: "Invalid lockfile structure" };
    }

    return { exists: true, hash, valid: true };
  } catch (err) {
    return { exists: true, hash: null, valid: false, error: `Failed to parse lockfile: ${String(err)}` };
  }
}

/**
 * SECURITY: SEC-26 — Generate Software Bill of Materials (SBOM).
 * Reads package.json and produces a dependency inventory.
 */
export async function generateSBOM(projectRoot: string): Promise<SBOMReport> {
  const pkgPath = join(projectRoot, "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw);

  const parseDeps = (deps: Record<string, string> | undefined): SBOMEntry[] => {
    if (!deps) return [];
    return Object.entries(deps).map(([name, version]) => ({
      name,
      version,
      pinned: isVersionPinned(version),
    }));
  };

  const dependencies = parseDeps(pkg.dependencies);
  const devDependencies = parseDeps(pkg.devDependencies);

  const allDeps = [...dependencies, ...devDependencies];
  const pinnedCount = allDeps.filter(d => d.pinned).length;

  const report: SBOMReport = {
    projectName: pkg.name ?? "unknown",
    projectVersion: pkg.version ?? "0.0.0",
    generatedAt: new Date().toISOString(),
    dependencies,
    devDependencies,
    totalDeps: allDeps.length,
    pinnedCount,
    unpinnedCount: allDeps.length - pinnedCount,
  };

  logger.info("SEC-26: SBOM generated", {
    total: report.totalDeps,
    pinned: report.pinnedCount,
    unpinned: report.unpinnedCount,
  });

  return report;
}

/**
 * SECURITY: SEC-26 — Audit dependencies for unpinned versions.
 * Returns list of dependencies that should be pinned.
 */
export async function auditUnpinned(projectRoot: string): Promise<string[]> {
  const sbom = await generateSBOM(projectRoot);
  const unpinned: string[] = [];

  for (const dep of [...sbom.dependencies, ...sbom.devDependencies]) {
    if (!dep.pinned) {
      unpinned.push(`${dep.name}@${dep.version}`);
    }
  }

  if (unpinned.length > 0) {
    logger.warn("SEC-26: Unpinned dependencies found", { count: unpinned.length });
  }

  return unpinned;
}
