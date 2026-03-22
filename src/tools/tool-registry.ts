// ═══════════════════════════════════════════════════════════════
// PEPAGI — Tool Registry (Worker Tools)
// ═══════════════════════════════════════════════════════════════

import { exec } from "node:child_process";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve, normalize, join, extname } from "node:path";
import { homedir } from "node:os";
import type { SecurityGuard, ActionCategory } from "../security/security-guard.js";
import { Logger } from "../core/logger.js";
import { eventBus } from "../core/event-bus.js";
// SECURITY: SEC-06 — ToolGuard for output sanitization, SSRF, timeouts, audit
import { sanitizeToolOutput, validateUrl, logToolCall, withTimeout } from "../security/tool-guard.js";
// SECURITY: SEC-11 — DLP for exfiltration channel blocking
import { dlpEngine } from "../security/dlp-engine.js";
// SECURITY: Centralized path validator — throws PathSecurityError on violation
import { validatePath, PathSecurityError } from "../security/path-validator.js";
import { duckduckgoSearch } from "./web-search.js";
import { homeAssistantTool } from "./home-assistant.js";
import { spotifyTool } from "./spotify.js";
import { youtubeTool } from "./youtube.js";
import { browserTool } from "./browser.js";
import { calendarTool } from "./calendar.js";
import { weatherTool } from "./weather.js";
import { notionTool } from "./notion.js";
import { dockerTool } from "./docker.js";
import { pdfTool } from "./pdf.js";
import { executeN8nWebhook } from "./n8n-webhook.js";
import { loadConfig } from "../config/loader.js";

const execAsync = promisify(exec);
const logger = new Logger("ToolRegistry");

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, string>, taskId: string, guard: SecurityGuard): Promise<ToolResult>;
}

// ─── Individual tool implementations ─────────────────────────

const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command. Will be validated by SecurityGuard.",
  async execute(args, taskId, guard) {
    const cmd = args.command ?? "";
    if (!cmd) return { success: false, output: "", error: "No command provided" };

    if (!guard.validateCommand(cmd)) {
      return { success: false, output: "", error: `Command blocked by security policy: ${cmd}` };
    }

    const allowed = await guard.authorize(taskId, "shell_destructive" as ActionCategory, cmd);
    if (!allowed) return { success: false, output: "", error: "Command not authorized" };

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000 });
      return { success: true, output: stdout + (stderr ? `\nSTDERR: ${stderr}` : "") };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("bash command failed", { cmd: cmd.slice(0, 100), error: msg, taskId });
      return { success: false, output: "", error: msg };
    }
  },
};

const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file.",
  async execute(args, taskId, guard) {
    const rawPath = args.path ?? "";
    if (!rawPath) return { success: false, output: "", error: "No path provided" };

    // SECURITY: Centralized path validation — throws on violation
    let safePath: string;
    try {
      safePath = await validatePath(rawPath, "read_file", taskId);
    } catch (err) {
      if (err instanceof PathSecurityError) return { success: false, output: "", error: `Access denied: ${err.message}` };
      throw err;
    }

    if (!guard.validateCommand(`cat ${safePath}`)) {
      return { success: false, output: "", error: `Path blocked: ${safePath}` };
    }

    try {
      const content = await readFile(safePath, "utf8");
      return { success: true, output: content };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file.",
  async execute(args, taskId, guard) {
    const { path: rawPath, content } = args;
    if (!rawPath || content === undefined) {
      return { success: false, output: "", error: "path and content are required" };
    }

    // SECURITY: Centralized path validation — throws on violation
    let safePath: string;
    try {
      safePath = await validatePath(rawPath, "write_file", taskId);
    } catch (err) {
      if (err instanceof PathSecurityError) return { success: false, output: "", error: `Access denied: ${err.message}` };
      throw err;
    }

    const allowed = await guard.authorize(taskId, "file_write_system" as ActionCategory, safePath);
    if (!allowed) return { success: false, output: "", error: "Write not authorized" };

    try {
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, content, "utf8");
      return { success: true, output: `Written ${content.length} bytes to ${safePath}` };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

const listDirTool: Tool = {
  name: "list_directory",
  description: "List contents of a directory.",
  async execute(args, taskId, _guard) {
    const rawPath = args.path ?? ".";

    // SECURITY: Centralized path validation — throws on violation
    let safePath: string;
    try {
      safePath = await validatePath(rawPath, "list_directory", taskId);
    } catch (err) {
      if (err instanceof PathSecurityError) return { success: false, output: "", error: `Access denied: ${err.message}` };
      throw err;
    }

    try {
      const entries = await readdir(safePath, { withFileTypes: true });
      const listing = entries.map(e => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
      return { success: true, output: listing };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch content from a URL.",
  async execute(args, taskId, guard) {
    const url = args.url ?? "";
    if (!url) return { success: false, output: "", error: "No URL provided" };

    const allowed = await guard.authorize(taskId, "network_external" as ActionCategory, url);
    if (!allowed) return { success: false, output: "", error: "Network access not authorized" };

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "PEPAGI-AGI/0.1" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { success: false, output: "", error: `HTTP ${res.status}` };
      const text = await res.text();
      // Truncate large responses
      return { success: true, output: text.slice(0, 10_000) };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

/** Safe download directory */
const DOWNLOAD_DIR = join("/tmp", "pepagi-downloads");

const webSearchTool: Tool = {
  name: "web_search",
  description: "Search the web using DuckDuckGo. Returns titles, URLs and snippets. No API key needed.",
  async execute(args, taskId, guard) {
    const query = args.query ?? "";
    if (!query) return { success: false, output: "", error: "No query provided" };

    const maxResults = Math.min(parseInt(args.maxResults ?? "10", 10) || 10, 20);

    const allowed = await guard.authorize(taskId, "network_external" as ActionCategory, `web_search: ${query}`);
    if (!allowed) return { success: false, output: "", error: "Web search not authorized" };

    try {
      const results = await duckduckgoSearch(query, maxResults);
      if (results.length === 0) {
        return { success: true, output: "Nenalezeny žádné výsledky pro: " + query };
      }
      const formatted = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
      ).join("\n\n");
      return { success: true, output: `Výsledky hledání pro "${query}" (${results.length}):\n\n${formatted}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("web_search failed", { query, error: msg, taskId });
      return { success: false, output: "", error: msg };
    }
  },
};

const downloadFileTool: Tool = {
  name: "download_file",
  description: "Download a file from a URL to /tmp/pepagi-downloads/. Returns the saved path and file size.",
  async execute(args, taskId, guard) {
    const url = args.url ?? "";
    if (!url) return { success: false, output: "", error: "No URL provided" };

    const allowed = await guard.authorize(taskId, "network_external" as ActionCategory, url);
    if (!allowed) return { success: false, output: "", error: "Download not authorized" };

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "PEPAGI-AGI/0.2" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { success: false, output: "", error: `HTTP ${res.status}` };

      // Determine filename
      let filename = args.filename ?? "";
      if (!filename) {
        const urlPath = new URL(url).pathname;
        filename = urlPath.split("/").pop() ?? "download";
        if (!filename || filename === "/") filename = "download";
        // Add extension from Content-Type if missing
        if (!extname(filename)) {
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("text/html")) filename += ".html";
          else if (ct.includes("application/json")) filename += ".json";
          else if (ct.includes("text/plain")) filename += ".txt";
          else if (ct.includes("application/pdf")) filename += ".pdf";
        }
      }

      // Sanitize filename (no path separators)
      filename = filename.replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");

      await mkdir(DOWNLOAD_DIR, { recursive: true });
      const savePath = join(DOWNLOAD_DIR, filename);

      // SECURITY: Validate the final save path before writing
      let safeSavePath: string;
      try {
        safeSavePath = await validatePath(savePath, "download_file", taskId);
      } catch (err) {
        if (err instanceof PathSecurityError) return { success: false, output: "", error: `Access denied: ${err.message}` };
        throw err;
      }

      const buffer = await res.arrayBuffer();
      await writeFile(safeSavePath, Buffer.from(buffer));

      const mimeType = res.headers.get("content-type") ?? "unknown";
      return {
        success: true,
        output: JSON.stringify({ path: safeSavePath, sizeBytes: buffer.byteLength, mimeType }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("download_file failed", { url, error: msg, taskId });
      return { success: false, output: "", error: msg };
    }
  },
};

// ─── Gmail tool ───────────────────────────────────────────────

const gmailTool: Tool = {
  name: "gmail_check",
  description: "Check Gmail for unread messages. Runs ~/.pepagi/tools/check-gmail.py if available, otherwise uses AppleScript on Mac.",
  async execute(args, taskId, guard) {
    const allowed = await guard.authorize(taskId, "network_external" as ActionCategory, "gmail_check");
    if (!allowed) return { success: false, output: "", error: "Gmail access not authorized" };

    const scriptPath = join(homedir(), ".pepagi", "tools", "check-gmail.py");
    const maxResults = args.maxResults ?? "5";
    const label = args.label ?? "INBOX";

    try {
      // Try Python script first
      const { existsSync } = await import("node:fs");
      if (existsSync(scriptPath)) {
        const { stdout, stderr } = await execAsync(
          `python3 "${scriptPath}" --max ${maxResults} --label "${label}"`,
          { timeout: 30_000 }
        );
        return { success: true, output: stdout + (stderr ? `\nSTDERR: ${stderr}` : "") };
      }

      // Fallback: AppleScript on macOS to read Mail.app
      const applescript = `
        tell application "Mail"
          set unreadMessages to messages of inbox whose read status is false
          set result to ""
          set counter to 0
          repeat with msg in unreadMessages
            if counter >= ${parseInt(maxResults, 10)} then exit repeat
            set result to result & "Od: " & (sender of msg) & "\\nPředmět: " & (subject of msg) & "\\nDatum: " & (date received of msg) & "\\n---\\n"
            set counter to counter + 1
          end repeat
          if result is "" then
            return "Žádné nepřečtené zprávy."
          end if
          return result
        end tell
      `;
      const { stdout } = await execAsync(`osascript -e '${applescript.replace(/'/g, "'\"'\"'")}'`, { timeout: 15_000 });
      return { success: true, output: stdout.trim() || "Žádné nepřečtené zprávy." };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("gmail_check failed", { error: msg, taskId });
      return { success: false, output: "", error: `Gmail check failed: ${msg}` };
    }
  },
};

// ─── GitHub tool ──────────────────────────────────────────────

const githubTool: Tool = {
  name: "github",
  description: "Interact with GitHub via gh CLI. Actions: pr_list, issue_list, notifications, repo_status, pr_create.",
  async execute(args, taskId, guard) {
    const allowed = await guard.authorize(taskId, "network_external" as ActionCategory, `github:${args.action}`);
    if (!allowed) return { success: false, output: "", error: "GitHub access not authorized" };

    const action = args.action ?? "notifications";
    const repo = args.repo ?? "";
    const limit = args.limit ?? "10";

    const repoFlag = repo ? ` -R "${repo}"` : "";

    const commands: Record<string, string> = {
      pr_list: `gh pr list${repoFlag} --limit ${limit} --json number,title,state,url,author,createdAt`,
      issue_list: `gh issue list${repoFlag} --limit ${limit} --json number,title,state,url,author,createdAt`,
      notifications: `gh api notifications --paginate --jq '.[:${limit}] | map({id: .id, title: .subject.title, type: .subject.type, repo: .repository.full_name, url: .subject.url, unread: .unread})'`,
      repo_status: `gh repo view${repoFlag} --json name,description,stargazerCount,forkCount,openIssues,url`,
      pr_status: `gh pr status${repoFlag} --json`,
    };

    const cmd = commands[action];
    if (!cmd) {
      return { success: false, output: "", error: `Unknown github action: ${action}. Available: ${Object.keys(commands).join(", ")}` };
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 20_000 });
      const output = stdout.trim();
      // Parse JSON and re-format nicely if possible
      try {
        const parsed = JSON.parse(output);
        return { success: true, output: JSON.stringify(parsed, null, 2) };
      } catch {
        return { success: true, output: output + (stderr ? `\nSTDERR: ${stderr}` : "") };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("github tool failed", { action, error: msg, taskId });
      return { success: false, output: "", error: `GitHub command failed: ${msg}` };
    }
  },
};

// ─── TTS tool ─────────────────────────────────────────────────

const TTS_OUTPUT = join("/tmp", "pepagi-tts");

const ttsTool: Tool = {
  name: "tts",
  description: "Convert text to speech. Saves audio to /tmp/pepagi-tts/. Returns file path. Supports Czech voice.",
  async execute(args, _taskId, _guard) {
    const text = args.text ?? "";
    if (!text) return { success: false, output: "", error: "No text provided" };

    // SEC-04: voice was passed raw into `say -v "${voice}"`, allowing shell
    // injection (e.g. `en-US"; rm -rf ~/; echo "`). Validate against a strict
    // allowlist — only letters, digits, spaces, and hyphens — and fall back to
    // the safe default "Zuzana" if the value does not match.
    const SAFE_VOICE_RE = /^[A-Za-z][A-Za-z0-9 \-]*$/;
    const rawVoice = args.voice ?? "Zuzana";
    const voice = SAFE_VOICE_RE.test(rawVoice) ? rawVoice : "Zuzana";
    const filename = args.filename ?? `tts_${Date.now()}`;
    const format = (args.format ?? "mp3").toLowerCase();

    await mkdir(TTS_OUTPUT, { recursive: true });

    // Sanitize text for shell (remove single quotes)
    const safeText = text.replace(/'/g, " ").replace(/\n/g, " ").slice(0, 2000);

    try {
      if (format === "mp3" || format === "ogg") {
        // macOS: say → aiff → ffmpeg → mp3/ogg
        const aiffPath = join(TTS_OUTPUT, `${filename}.aiff`);
        const outPath = join(TTS_OUTPUT, `${filename}.${format}`);
        await execAsync(`say -v "${voice}" -o "${aiffPath}" '${safeText}'`, { timeout: 30_000 });
        // Try converting with ffmpeg if available
        try {
          await execAsync(`ffmpeg -y -i "${aiffPath}" "${outPath}" 2>/dev/null`, { timeout: 30_000 });
          return { success: true, output: JSON.stringify({ path: outPath, voice, format }) };
        } catch {
          // ffmpeg not available — return aiff
          return { success: true, output: JSON.stringify({ path: aiffPath, voice, format: "aiff" }) };
        }
      } else {
        // Direct aiff output
        const outPath = join(TTS_OUTPUT, `${filename}.aiff`);
        await execAsync(`say -v "${voice}" -o "${outPath}" '${safeText}'`, { timeout: 30_000 });
        return { success: true, output: JSON.stringify({ path: outPath, voice, format: "aiff" }) };
      }
    } catch (err) {
      // Last resort: just play it without saving
      try {
        await execAsync(`say -v "${voice}" '${safeText}'`, { timeout: 30_000 });
        return { success: true, output: "Text přečten (bez uložení souboru)." };
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        return { success: false, output: "", error: `TTS failed: ${msg}` };
      }
    }
  },
};

// ─── Registry ─────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    this.register(bashTool);
    this.register(readFileTool);
    this.register(writeFileTool);
    this.register(listDirTool);
    this.register(webFetchTool);
    this.register(webSearchTool);
    this.register(downloadFileTool);
    this.register(gmailTool);
    this.register(githubTool);
    this.register(ttsTool);

    // Home Assistant tool — wrap into Tool interface
    this.register({
      name: homeAssistantTool.name,
      description: homeAssistantTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return homeAssistantTool.execute(args);
      },
    });

    // Spotify tool
    this.register({
      name: spotifyTool.name,
      description: spotifyTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return spotifyTool.execute(args);
      },
    });

    // YouTube tool
    this.register({
      name: youtubeTool.name,
      description: youtubeTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return youtubeTool.execute(args);
      },
    });

    // Browser automation tool
    this.register({
      name: browserTool.name,
      description: browserTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return browserTool.execute(args);
      },
    });

    // Calendar tool
    this.register({
      name: calendarTool.name,
      description: calendarTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return calendarTool.execute(args);
      },
    });

    // Weather tool
    this.register({
      name: weatherTool.name,
      description: weatherTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return weatherTool.execute(args);
      },
    });

    // Notion tool
    this.register({
      name: notionTool.name,
      description: notionTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return notionTool.execute(args);
      },
    });

    // Docker management tool
    this.register({
      name: dockerTool.name,
      description: dockerTool.description,
      async execute(args: Record<string, string>, taskId: string, guard: SecurityGuard): Promise<ToolResult> {
        return dockerTool.execute(args, taskId, guard);
      },
    });

    // PDF generation tool
    this.register({
      name: pdfTool.name,
      description: pdfTool.description,
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        return pdfTool.execute(args);
      },
    });

    // n8n webhook tool — sends payloads to user-configured n8n workflows
    this.register({
      name: "n8n_webhook",
      description: "Send a payload to an n8n workflow webhook. Args: webhook_path (required), payload (JSON string), method (default POST).",
      async execute(args: Record<string, string>, _taskId: string, _guard: SecurityGuard): Promise<ToolResult> {
        const config = await loadConfig();
        return executeN8nWebhook(args, config.n8n);
      },
    });
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Execute a tool by name.
   */
  async execute(name: string, args: Record<string, string>, taskId: string, guard: SecurityGuard): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, output: "", error: `Unknown tool: ${name}` };

    // SECURITY: SEC-06 — SSRF check for URL-accepting tools
    if ((name === "web_fetch" || name === "browser" || name === "download_file") && args.url) {
      const urlCheck = validateUrl(args.url);
      if (!urlCheck.valid) {
        logger.warn("ToolGuard: URL blocked", { tool: name, url: args.url, reason: urlCheck.reason, taskId });
        eventBus.emit({ type: "security:tool_blocked", tool: name, reason: urlCheck.reason ?? "SSRF", taskId });
        return { success: false, output: "", error: `URL blocked: ${urlCheck.reason}` };
      }

      // SECURITY: SEC-11 — DLP check for exfiltration via outbound requests
      const argsText = Object.values(args).join(" ");
      const dlpResult = dlpEngine.inspect(argsText, args.url);
      if (!dlpResult.allowed) {
        logger.warn("SEC-11: DLP blocked outbound request", { tool: name, url: args.url, issues: dlpResult.issues, taskId });
        eventBus.emit({ type: "security:tool_blocked", tool: name, reason: `DLP: ${dlpResult.issues.join(", ")}`, taskId });
        return { success: false, output: "", error: `DLP blocked: ${dlpResult.issues.join(", ")}` };
      }
    }

    logger.debug(`Executing tool: ${name}`, { args, taskId });
    eventBus.emit({ type: "tool:call", taskId, tool: name, input: args as Record<string, unknown> });

    // SECURITY: SEC-06 — Execute with timeout
    let result: ToolResult;
    try {
      result = await withTimeout(() => tool.execute(args, taskId, guard));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { success: false, output: "", error: msg };
    }

    // SECURITY: SEC-06 — Sanitize output before returning
    result.output = sanitizeToolOutput(result.output, name);

    // SECURITY: SEC-06 — Audit log every tool call
    void logToolCall(name, taskId, args, result);

    eventBus.emit({ type: "tool:result", taskId, tool: name, success: result.success, output: (result.output || result.error || "").slice(0, 200) });
    return result;
  }

  /** Get tool descriptions for LLM prompt */
  getDescriptions(): string {
    return this.getAll()
      .map(t => `- **${t.name}**: ${t.description}`)
      .join("\n");
  }
}
