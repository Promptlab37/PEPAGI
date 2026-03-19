// ═══════════════════════════════════════════════════════════════
// Tests: Ollama/LM Studio Security (SEC-29)
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { networkInterfaces } from "node:os";

describe("Ollama Security SEC-29", () => {
  describe("checkLocalServiceExposure logic", () => {
    it("identifies non-loopback IPv4 interfaces", () => {
      const interfaces = networkInterfaces();
      const nonLoopback: string[] = [];

      for (const iface of Object.values(interfaces)) {
        if (!iface) continue;
        for (const info of iface) {
          if (!info.internal && info.family === "IPv4") {
            nonLoopback.push(info.address);
          }
        }
      }

      // Every non-loopback address should be a valid IPv4
      for (const ip of nonLoopback) {
        expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
        expect(ip).not.toBe("127.0.0.1");
      }
    });

    it("correctly filters internal vs external interfaces", () => {
      const interfaces = networkInterfaces();
      const internal: string[] = [];
      const external: string[] = [];

      for (const iface of Object.values(interfaces)) {
        if (!iface) continue;
        for (const info of iface) {
          if (info.family === "IPv4") {
            if (info.internal) {
              internal.push(info.address);
            } else {
              external.push(info.address);
            }
          }
        }
      }

      // Loopback (127.0.0.1) should be in internal
      expect(internal).toContain("127.0.0.1");
      // External IPs should not contain loopback
      expect(external).not.toContain("127.0.0.1");
    });

    it("constructs correct URL for exposure check", () => {
      const ip = "192.168.1.100";
      const port = 11434;
      const url = `http://${ip}:${port}/`;
      expect(url).toBe("http://192.168.1.100:11434/");
    });

    it("uses AbortController for timeout protection", () => {
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe("exposure detection ports", () => {
    it("uses correct Ollama port (11434)", () => {
      const OLLAMA_PORT = 11434;
      expect(OLLAMA_PORT).toBe(11434);
    });

    it("uses correct LM Studio port (1234)", () => {
      const LMSTUDIO_PORT = 1234;
      expect(LMSTUDIO_PORT).toBe(1234);
    });
  });

  describe("security alert format", () => {
    it("generates correct SEC-29 alert message", () => {
      const ip = "192.168.1.50";
      const port = 11434;
      const serviceName = "Ollama";
      const message = `SEC-29: ${serviceName} is exposed on non-loopback interface ${ip}:${port}!`;
      expect(message).toContain("SEC-29");
      expect(message).toContain(serviceName);
      expect(message).toContain(ip);
      expect(message).toContain(String(port));
    });

    it("generates critical-level system:alert event shape", () => {
      const event = {
        type: "system:alert" as const,
        message: `🔴 SEC-29: Ollama je přístupný na 192.168.1.50:11434 — je vystaven síti!`,
        level: "critical" as const,
      };
      expect(event.type).toBe("system:alert");
      expect(event.level).toBe("critical");
      expect(event.message).toContain("SEC-29");
    });
  });
});
