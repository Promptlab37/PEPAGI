// ═══════════════════════════════════════════════════════════════
// PEPAGI — Daemon Control
// start / stop / restart / status / install / uninstall
// ═══════════════════════════════════════════════════════════════

import { readFile, unlink, open, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform, homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { PEPAGI_DATA_DIR } from "./config/loader.js";

// ─── Paths ────────────────────────────────────────────────────

/** Project root (one level above src/) */
const INSTALL_DIR   = fileURLToPath(new URL("..", import.meta.url));
const PID_FILE      = join(PEPAGI_DATA_DIR, "daemon.pid");
const LOG_FILE      = join(PEPAGI_DATA_DIR, "logs", "daemon.log");
const TSX_BIN       = join(INSTALL_DIR, "node_modules", ".bin", "tsx");
const DAEMON_SCRIPT = join(INSTALL_DIR, "src", "daemon.ts");

// ─── Helpers ─────────────────────────────────────────────────

async function readPid(): Promise<number | null> {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = await readFile(PID_FILE, "utf8");
    const pid = parseInt(raw.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Status ──────────────────────────────────────────────────

export async function daemonStatus(): Promise<void> {
  const pid = await readPid();

  if (pid === null) {
    console.log(chalk.yellow("Daemon: neběží") + chalk.gray(" (PID soubor nenalezen)"));
    return;
  }

  if (isAlive(pid)) {
    console.log(chalk.green(`Daemon: běží`) + chalk.gray(` (PID ${pid})`));
    console.log(chalk.gray(`  Logy: ${LOG_FILE}`));
  } else {
    console.log(chalk.red(`Daemon: mrtvý`) + chalk.gray(` (PID ${pid} neodpovídá, odstraňuji PID soubor)`));
    try { await unlink(PID_FILE); } catch { /* ignore */ }
  }
}

// ─── Start ───────────────────────────────────────────────────

export async function daemonStart(): Promise<void> {
  const existingPid = await readPid();
  if (existingPid !== null && isAlive(existingPid)) {
    console.log(chalk.yellow(`Daemon již běží (PID ${existingPid}).`));
    return;
  }

  await mkdir(join(PEPAGI_DATA_DIR, "logs"), { recursive: true });

  const logHandle = await open(LOG_FILE, "a");

  const child = spawn(
    process.execPath,
    [TSX_BIN, DAEMON_SCRIPT],
    {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      cwd: INSTALL_DIR,
    }
  );

  child.unref();
  await logHandle.close();

  console.log(chalk.cyan("Daemon spouštím…"));

  // daemon.ts writes PID file immediately on start — wait briefly
  await sleep(3000);

  const pid = await readPid();
  if (pid !== null && isAlive(pid)) {
    console.log(chalk.green(`Daemon spuštěn (PID ${pid}).`));
    console.log(chalk.gray(`  Logy: tail -f ${LOG_FILE}`));
    console.log(chalk.gray("  pepagi daemon stop — pro zastavení"));
  } else {
    console.log(chalk.red("Daemon se nepodařilo spustit."));
    console.log(chalk.gray(`  Zkontroluj logy: tail -f ${LOG_FILE}`));
    process.exit(1);
  }
}

// ─── Stop ────────────────────────────────────────────────────

export async function daemonStop(): Promise<void> {
  const pid = await readPid();

  if (pid === null) {
    console.log(chalk.yellow("Daemon neběží (PID soubor nenalezen)."));
    return;
  }

  if (!isAlive(pid)) {
    console.log(chalk.yellow(`PID ${pid} neodpovídá — odstraňuji PID soubor.`));
    try { await unlink(PID_FILE); } catch { /* ignore */ }
    return;
  }

  console.log(chalk.cyan(`Zastavuji daemon (PID ${pid})…`));

  try { process.kill(pid, "SIGTERM"); } catch {
    console.log(chalk.red(`Nepodařilo se odeslat SIGTERM procesu ${pid}.`));
    return;
  }

  // Wait up to 5s for graceful shutdown
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (!isAlive(pid)) break;
  }

  // Force kill if still alive
  if (isAlive(pid)) {
    console.log(chalk.yellow("Vynucuji zastavení (SIGKILL)…"));
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    await sleep(300);
  }

  if (existsSync(PID_FILE)) {
    try { await unlink(PID_FILE); } catch { /* ignore */ }
  }

  console.log(chalk.green("Daemon zastaven."));
}

// ─── Restart ─────────────────────────────────────────────────

export async function daemonRestart(): Promise<void> {
  await daemonStop();
  await sleep(500);
  await daemonStart();
}

// ─── Install ─────────────────────────────────────────────────

export async function daemonInstall(): Promise<void> {
  const os = platform();

  if (os === "darwin") {
    await installMacOS();
  } else if (os === "linux") {
    await installLinux();
  } else if (os === "win32") {
    await installWindows();
  } else {
    console.log(chalk.red(`Automatická instalace není podporována na ${os}.`));
    console.log(chalk.gray("  Použij: pepagi daemon start — pro ruční spuštění"));
    process.exit(1);
  }
}

async function installMacOS(): Promise<void> {
  const plistDir  = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.pepagiagi.daemon.plist");

  await mkdir(plistDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pepagiagi.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${TSX_BIN}</string>
    <string>${DAEMON_SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(plistPath, plist, "utf8");

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`, { stdio: "inherit" });
  } catch {
    console.log(chalk.yellow("launchctl load se nezdařilo — zkus manuálně:"));
    console.log(chalk.gray(`  launchctl load "${plistPath}"`));
  }

  console.log(chalk.green("macOS LaunchAgent nainstalován."));
  console.log(chalk.gray(`  Soubor: ${plistPath}`));
  console.log(chalk.gray("  Daemon se spustí automaticky po přihlášení."));
  console.log(chalk.gray("  pepagi daemon uninstall — pro odebrání"));
}

async function installLinux(): Promise<void> {
  const systemdDir = join(homedir(), ".config", "systemd", "user");
  const unitPath   = join(systemdDir, "pepagiagi.service");

  await mkdir(systemdDir, { recursive: true });

  const unit = `[Unit]
Description=PEPAGI Daemon
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${TSX_BIN} ${DAEMON_SCRIPT}
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(unitPath, unit, "utf8");

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync("systemctl --user enable pepagiagi.service", { stdio: "inherit" });
    execSync("systemctl --user start pepagiagi.service", { stdio: "inherit" });
  } catch {
    console.log(chalk.yellow("systemctl selhal — zkus manuálně:"));
    console.log(chalk.gray("  systemctl --user daemon-reload"));
    console.log(chalk.gray("  systemctl --user enable pepagiagi"));
    console.log(chalk.gray("  systemctl --user start pepagiagi"));
  }

  console.log(chalk.green("systemd user service nainstalován."));
  console.log(chalk.gray(`  Soubor: ${unitPath}`));
}

async function installWindows(): Promise<void> {
  const taskName = "PepagiAGIDaemon";
  const cmd = [
    "schtasks", "/Create",
    "/TN", taskName,
    "/TR", `"${process.execPath}" "${TSX_BIN}" "${DAEMON_SCRIPT}"`,
    "/SC", "ONLOGON", "/RL", "HIGHEST", "/F",
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit", shell: "/bin/sh" });
    console.log(chalk.green(`Windows Scheduled Task "${taskName}" vytvořen.`));
    console.log(chalk.gray("  Daemon se spustí automaticky po přihlášení."));
  } catch {
    console.log(chalk.red("Nepodařilo se vytvořit Scheduled Task."));
    console.log(chalk.gray(`  Zkus manuálně: ${cmd}`));
    process.exit(1);
  }
}

// ─── Uninstall ───────────────────────────────────────────────

export async function daemonUninstall(): Promise<void> {
  // Stop first
  await daemonStop();

  const os = platform();

  if (os === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.pepagiagi.daemon.plist");
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "pipe" }); } catch { /* ignore */ }
    if (existsSync(plistPath)) {
      await unlink(plistPath);
      console.log(chalk.green("macOS LaunchAgent odinstalován."));
    } else {
      console.log(chalk.yellow("LaunchAgent plist nenalezen."));
    }
  } else if (os === "linux") {
    try {
      execSync("systemctl --user stop pepagiagi.service 2>/dev/null", { stdio: "pipe" });
      execSync("systemctl --user disable pepagiagi.service 2>/dev/null", { stdio: "pipe" });
    } catch { /* ignore */ }
    const unitPath = join(homedir(), ".config", "systemd", "user", "pepagiagi.service");
    if (existsSync(unitPath)) {
      await unlink(unitPath);
      try { execSync("systemctl --user daemon-reload", { stdio: "pipe" }); } catch { /* ignore */ }
      console.log(chalk.green("systemd user service odinstalován."));
    } else {
      console.log(chalk.yellow("systemd unit soubor nenalezen."));
    }
  } else if (os === "win32") {
    try {
      execSync('schtasks /Delete /TN "PepagiAGIDaemon" /F', { stdio: "inherit", shell: "cmd.exe" });
      console.log(chalk.green("Windows Scheduled Task odstraněna."));
    } catch {
      console.log(chalk.yellow("Scheduled task nenalezena nebo se nepodařilo odstranit."));
    }
  } else {
    console.log(chalk.red(`Nepodporovaný OS: ${os}`));
  }
}
