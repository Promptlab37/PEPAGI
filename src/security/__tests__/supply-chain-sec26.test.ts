// ═══════════════════════════════════════════════════════════════
// Tests: Deep Supply Chain Attacks (SEC-26)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isVersionPinned,
  checkSlopsquatting,
  verifyLockfile,
  generateSBOM,
  auditUnpinned,
} from "../supply-chain.js";

describe("Supply Chain Security SEC-26", () => {
  describe("version pinning check", () => {
    it("detects pinned versions", () => {
      expect(isVersionPinned("1.2.3")).toBe(true);
      expect(isVersionPinned("0.0.1")).toBe(true);
      expect(isVersionPinned("2.0.0-beta.1")).toBe(true);
    });

    it("detects unpinned versions", () => {
      expect(isVersionPinned("^1.2.3")).toBe(false);
      expect(isVersionPinned("~1.2.3")).toBe(false);
      expect(isVersionPinned(">=1.0.0")).toBe(false);
      expect(isVersionPinned("*")).toBe(false);
      expect(isVersionPinned("latest")).toBe(false);
    });
  });

  describe("slopsquatting detection", () => {
    it("flags suspicious package names", () => {
      expect(checkSlopsquatting("my-awesome-library")).toBe(true);
      expect(checkSlopsquatting("the-utils")).toBe(true);
    });

    it("allows legitimate package names", () => {
      expect(checkSlopsquatting("express")).toBe(false);
      expect(checkSlopsquatting("lodash")).toBe(false);
      expect(checkSlopsquatting("@types/node")).toBe(false);
      expect(checkSlopsquatting("vitest")).toBe(false);
    });
  });

  describe("lockfile verification", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "sec26-lock-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("detects missing lockfile", async () => {
      const result = await verifyLockfile(tmpDir);
      expect(result.exists).toBe(false);
      expect(result.valid).toBe(false);
    });

    it("validates correct lockfile", async () => {
      await writeFile(
        join(tmpDir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages: {} }),
      );
      const result = await verifyLockfile(tmpDir);
      expect(result.exists).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.hash).toBeTruthy();
    });

    it("rejects invalid lockfile structure", async () => {
      await writeFile(join(tmpDir, "package-lock.json"), JSON.stringify({ foo: "bar" }));
      const result = await verifyLockfile(tmpDir);
      expect(result.exists).toBe(true);
      expect(result.valid).toBe(false);
    });

    it("rejects malformed JSON", async () => {
      await writeFile(join(tmpDir, "package-lock.json"), "not json{{{");
      const result = await verifyLockfile(tmpDir);
      expect(result.exists).toBe(true);
      expect(result.valid).toBe(false);
    });
  });

  describe("SBOM generation", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "sec26-sbom-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("generates SBOM from package.json", async () => {
      await writeFile(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          version: "1.0.0",
          dependencies: { express: "4.18.2", lodash: "^4.17.21" },
          devDependencies: { vitest: "1.0.0" },
        }),
      );

      const sbom = await generateSBOM(tmpDir);
      expect(sbom.projectName).toBe("test-project");
      expect(sbom.totalDeps).toBe(3);
      expect(sbom.pinnedCount).toBe(2); // express + vitest
      expect(sbom.unpinnedCount).toBe(1); // lodash
      expect(sbom.dependencies).toHaveLength(2);
      expect(sbom.devDependencies).toHaveLength(1);
    });

    it("handles empty dependencies", async () => {
      await writeFile(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "empty", version: "0.0.0" }),
      );

      const sbom = await generateSBOM(tmpDir);
      expect(sbom.totalDeps).toBe(0);
    });
  });

  describe("unpinned dependency audit", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "sec26-audit-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("reports unpinned dependencies", async () => {
      await writeFile(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test",
          version: "1.0.0",
          dependencies: { a: "^1.0.0", b: "2.0.0", c: "~3.0.0" },
        }),
      );

      const unpinned = await auditUnpinned(tmpDir);
      expect(unpinned).toHaveLength(2);
      expect(unpinned).toContain("a@^1.0.0");
      expect(unpinned).toContain("c@~3.0.0");
    });

    it("returns empty for all pinned", async () => {
      await writeFile(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test",
          version: "1.0.0",
          dependencies: { a: "1.0.0", b: "2.0.0" },
        }),
      );

      const unpinned = await auditUnpinned(tmpDir);
      expect(unpinned).toHaveLength(0);
    });
  });
});
