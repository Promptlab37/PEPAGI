// ═══════════════════════════════════════════════════════════════
// Tests: Skill Scanner SEC-03 — Obfuscation detection
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkillFile } from "../skill-scanner.js";

const TEST_DIR = join(tmpdir(), "pepagi-test-sec03");

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

async function writeSkill(name: string, code: string): Promise<string> {
  const path = join(TEST_DIR, name);
  await writeFile(path, code, "utf8");
  return path;
}

describe("SkillScanner SEC-03 — Obfuscation Detection", () => {
  it("detects string concatenation in bracket notation", async () => {
    const path = await writeSkill("obf1.js", `
      const x = {};
      x["ev" + "al"]("dangerous code");
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("obfuscation"))).toBe(true);
    expect(result.approved).toBe(false);
  });

  it("detects String.fromCharCode obfuscation", async () => {
    const path = await writeSkill("obf2.js", `
      const fn = String.fromCharCode(101, 118, 97, 108);
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("charCode"))).toBe(true);
    expect(result.approved).toBe(false);
  });

  it("detects atob/btoa usage", async () => {
    const path = await writeSkill("obf3.js", `
      const code = atob("ZXZhbA==");
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("atob"))).toBe(true);
  });

  it("detects string reverse obfuscation", async () => {
    const path = await writeSkill("obf4.js", `
      const cmd = "lave".split("").reverse().join("");
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("reverse"))).toBe(true);
  });

  it("detects dynamic property access on process", async () => {
    const path = await writeSkill("obf5.js", `
      const key = "env";
      const val = process[key];
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("Dynamic property access"))).toBe(true);
  });

  it("detects with() statement", async () => {
    const path = await writeSkill("obf6.js", `
      with(console) { log("hi"); }
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("with()"))).toBe(true);
  });

  it("detects Proxy usage", async () => {
    const path = await writeSkill("obf7.js", `
      const p = new Proxy(target, handler);
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("Proxy"))).toBe(true);
  });

  it("approves safe skill code", async () => {
    const path = await writeSkill("safe.js", `
      export default {
        name: "safe-skill",
        triggerPatterns: ["hello"],
        async handler(ctx) {
          return { success: true, output: "Hello!" };
        },
      };
    `);
    const result = await scanSkillFile(path);
    expect(result.approved).toBe(true);
    expect(result.riskLevel).toBe("safe");
  });

  it("detects template literal in bracket notation", async () => {
    const path = await writeSkill("obf8.js", 'const x = obj[`${"ev"}al`];');
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("Template literal"))).toBe(true);
  });

  it("detects Reflect.apply usage", async () => {
    const path = await writeSkill("obf9.js", `
      Reflect.apply(eval, null, ["code"]);
    `);
    const result = await scanSkillFile(path);
    expect(result.findings.some(f => f.description.includes("Reflect"))).toBe(true);
  });
});
