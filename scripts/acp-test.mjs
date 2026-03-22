#!/usr/bin/env node
// ACP JSON-RPC 2.0 test — correct protocol per agentclientprotocol.com spec
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const MODEL = process.argv[2] || "qwen3-coder-next";
const CWD = resolve(".");
console.log(`\n=== ACP Test — model: ${MODEL}, cwd: ${CWD} ===\n`);

// Pass --model directly to kiro-cli acp
const child = spawn("kiro-cli", ["acp", "--model", MODEL], {
  stdio: ["pipe", "pipe", "pipe"],
});

let lineBuffer = "";
const allMessages = [];
const pendingResolvers = new Map();

function processLine(line) {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && !msg.method) {
      const p = JSON.stringify(msg).slice(0, 300);
      console.log(`<<< RESP id=${msg.id}: ${p}`);
    } else if (msg.method === "session/update") {
      const u = msg.params?.update;
      const type = u?.sessionUpdate || "?";
      const text = u?.content?.text || "";
      console.log(`<<< [${type}]${text ? " " + text.slice(0, 120) : ""}`);
    } else if (msg.method) {
      console.log(`<<< ${msg.method}`);
    }
    allMessages.push(msg);
    if (msg.id != null && pendingResolvers.has(msg.id)) {
      pendingResolvers.get(msg.id)(msg);
      pendingResolvers.delete(msg.id);
    }
  } catch {
    console.log(`<<< (non-JSON): ${line.slice(0, 200)}`);
  }
}

child.stdout.on("data", (chunk) => {
  lineBuffer += chunk.toString();
  const lines = lineBuffer.split("\n");
  lineBuffer = lines.pop();
  for (const line of lines) processLine(line);
});
child.stderr.on("data", (chunk) => {
  const t = chunk.toString().trim();
  if (t) console.log(`[stderr]: ${t.slice(0, 300)}`);
});
child.on("exit", (code) => console.log(`[exit ${code}]`));

function send(id, method, params) {
  const msg = id != null
    ? { jsonrpc: "2.0", id, method, params }
    : { jsonrpc: "2.0", method, params };
  console.log(`\n>>> ${method} (id=${id ?? "notif"})`);
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function waitForId(id, timeoutMs = 30000) {
  const existing = allMessages.find((r) => r.id === id && !r.method);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResolvers.delete(id);
      reject(new Error(`Timeout waiting for id=${id}`));
    }, timeoutMs);
    pendingResolvers.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try {
    // 1. Initialize
    send(1, "initialize", {
      clientName: "pepagi",
      clientVersion: "0.5.0",
      protocolVersion: 1,
    });
    const init = await waitForId(1);
    console.log(`✓ Initialize — ${init.result?.agentInfo?.name} v${init.result?.agentInfo?.version}`);

    // 2. Create session
    send(2, "session/new", { cwd: CWD, mcpServers: [] });
    const sess = await waitForId(2, 30000);
    if (sess.error) throw new Error(`session/new: ${sess.error.message}`);
    const sessionId = sess.result?.sessionId;
    console.log(`✓ Session: ${sessionId}`);

    // Log available modes
    const modes = sess.result?.modes?.availableModes?.map((m) => m.id) || [];
    console.log(`  Modes: ${modes.join(", ")}`);
    console.log(`  Current: ${sess.result?.modes?.currentModeId}`);

    // Check for config options (model selector)
    if (sess.result?.configOptions) {
      console.log(`  Config options: ${JSON.stringify(sess.result.configOptions)}`);
    }

    // 3. Set mode to kiro_default (read-only isn't a mode — modes are agent-specific)
    // Skip set_mode for now, use default

    // 4. Send prompt
    console.log("\n--- Sending prompt ---");
    send(3, "session/prompt", {
      sessionId,
      prompt: [
        { type: "text", text: "What is 2+2? Reply with just the number." },
      ],
    });

    console.log("--- Waiting for response (up to 60s) ---\n");
    const promptResp = await waitForId(3, 60000);

    await sleep(500);

    // Summarize
    const updates = allMessages.filter((m) => m.method === "session/update");
    const agentChunks = updates.filter(
      (m) => m.params?.update?.sessionUpdate === "agent_message_chunk"
    );
    const toolCalls = updates.filter(
      (m) => m.params?.update?.sessionUpdate === "tool_call"
    );

    let fullText = "";
    for (const c of agentChunks) {
      fullText += c.params?.update?.content?.text || "";
    }

    console.log("\n=== SUMMARY ===");
    console.log(`session/update notifications: ${updates.length}`);
    console.log(`  agent_message_chunk: ${agentChunks.length}`);
    console.log(`  tool_call: ${toolCalls.length}`);
    console.log(`Response: "${fullText}"`);
    console.log(`Stop reason: ${promptResp.result?.stopReason}`);
    if (promptResp.result?.usage) {
      console.log(`Usage: ${JSON.stringify(promptResp.result.usage)}`);
    }
    console.log("\n✓ ACP test complete!");
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      process.exit(0);
    }, 3000);
  }
}

main();
