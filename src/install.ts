/** Find where Escape from Tarkov is installed, without asking. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

function regExe(): string {
  const sysRoot = process.env.SystemRoot || process.env.windir;
  return sysRoot ? join(sysRoot, "System32", "reg.exe") : "reg.exe";
}

/** Parse `reg query /s` output for entries whose DisplayName is EFT (not Arena). */
export function installsFromRegDump(dump: string): string[] {
  const out: string[] = [];
  const blocks = dump.split(/\r?\n(?=HK)/);
  for (const b of blocks) {
    const name = /DisplayName\s+REG_SZ\s+(.+)/.exec(b)?.[1]?.trim() ?? "";
    if (!/^Escape from Tarkov$/i.test(name)) continue;
    const loc = /InstallLocation\s+REG_SZ\s+(.+)/.exec(b)?.[1]?.trim();
    if (loc) out.push(loc.replace(/[\\/]+$/, ""));
  }
  return out;
}

/** Steam library folders from libraryfolders.vdf → possible EFT paths. */
export function installsFromSteamVdf(vdf: string): string[] {
  const paths = [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, "\\"));
  return paths.map((p) => join(p, "steamapps", "common", "Escape from Tarkov"));
}

export function detectInstall(): string | null {
  const candidates: string[] = [];
  for (const key of UNINSTALL_KEYS) {
    try {
      const dump = execFileSync(regExe(), ["query", key, "/s"], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      candidates.push(...installsFromRegDump(dump));
    } catch {
      /* key missing or reg unavailable */
    }
  }
  const pf = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  for (const vdf of [join(pf, "Steam", "steamapps", "libraryfolders.vdf"), "C:\\Steam\\steamapps\\libraryfolders.vdf"]) {
    try {
      candidates.push(...installsFromSteamVdf(readFileSync(vdf, "utf8")));
    } catch {
      /* not there */
    }
  }
  candidates.push("C:\\Battlestate Games\\EFT", "C:\\Battlestate Games\\Escape from Tarkov", "C:\\Steam\\steamapps\\common\\Escape from Tarkov");
  for (const c of candidates) {
    if (existsSync(join(c, "build", "Logs")) || existsSync(join(c, "Logs")) || existsSync(join(c, "build", "EscapeFromTarkov.exe")) || existsSync(join(c, "EscapeFromTarkov.exe"))) return c;
  }
  return null;
}

/** MyDocuments as Windows resolves it (OneDrive redirection included). */
export function myDocuments(): string {
  try {
    const out = execFileSync(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetFolderPath('MyDocuments')"],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    ).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }
  return join(process.env.USERPROFILE || "C:\\Users\\Default", "Documents");
}
