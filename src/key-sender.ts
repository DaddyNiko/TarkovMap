/**
 * Presses the game's Screenshot key so the position refreshes.
 *
 * Three modes, all plain user-level `SendInput` (the same call a keyboard
 * driver's software makes) and all gated on EscapeFromTarkov being the
 * foreground window:
 *   auto   — sends every `intervalMs` whenever Tarkov or Arena is the front
 *            window. Nothing to hold, nothing to switch on: start the game, it runs.
 *   manual — never sends; the player taps the key themself.
 *   hold   — sends every `intervalMs` while `holdKey` is physically held.
 *   timer  — sends every `intervalMs` whenever `inRaid` is true.
 *
 * One PowerShell helper stays resident (spawning one per press would cost
 * ~300 ms and a console flash). It reads commands on stdin and reports on
 * stdout, so the app never has to poll anything itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";

export type SendMode = "auto" | "manual" | "hold" | "timer";

export interface KeySenderConfig {
  mode: SendMode;
  /** Virtual-key name of EFT's Screenshot bind, e.g. "F11". */
  screenshotKey: string;
  /** Key held to stream in `hold` mode, e.g. "CapsLock". */
  holdKey: string;
  intervalMs: number;
}

export const DEFAULT_SENDER: KeySenderConfig = { mode: "auto", screenshotKey: "F11", holdKey: "CapsLock", intervalMs: 2000 };

/** Names accepted by the settings screen → Win32 virtual-key codes. */
export const VK: Record<string, number> = {
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  PrintScreen: 0x2c, ScrollLock: 0x91, Pause: 0x13, Insert: 0x2d, Home: 0x24, PageUp: 0x21, PageDown: 0x22, End: 0x23, Delete: 0x2e,
  CapsLock: 0x14, Tab: 0x09, Space: 0x20, Backspace: 0x08, Enter: 0x0d,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64, Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  LeftShift: 0xa0, RightShift: 0xa1, LeftCtrl: 0xa2, RightCtrl: 0xa3, LeftAlt: 0xa4, RightAlt: 0xa5,
  Mouse4: 0x05, Mouse5: 0x06, Mouse3: 0x04,
};
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c)] = c;
for (let d = 0; d <= 9; d++) VK[String(d)] = 48 + d;

export function vkFor(name: string): number | null {
  const k = Object.keys(VK).find((x) => x.toLowerCase() === name.trim().toLowerCase());
  return k ? VK[k] : null;
}

/** Absolute PowerShell path — a stripped PATH is a documented hazard here. */
export function powershellExe(): string {
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) {
    const abs = resolve(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(abs)) return abs;
  }
  return "powershell.exe";
}

/**
 * The resident helper. Commands (one per line on stdin):
 *   cfg <mode> <screenshotVk> <holdVk> <intervalMs>
 *   raid 0|1
 *   press            (one immediate press if EFT is foreground)
 *   quit
 * Output lines: `sent`, `skip-foreground`, `hold-start`, `hold-stop`, `fg <process>` (foreground app
 * changed; polled twice a second), `game 1|0` (Tarkov/Arena process exists; polled every 5 s), `err <text>`.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = "Continue"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TkInput {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  public static bool Press(ushort vk) {
    ushort scan = (ushort)MapVirtualKey(vk, 0);
    bool ext = vk == 0x2C || vk == 0x2D || vk == 0x2E || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22 || vk == 0x6F;
    uint flags = ext ? 1u : 0u;
    INPUT[] a = new INPUT[2];
    a[0].type = 1; a[0].u.ki.wVk = vk; a[0].u.ki.wScan = scan; a[0].u.ki.dwFlags = flags;
    a[1].type = 1; a[1].u.ki.wVk = vk; a[1].u.ki.wScan = scan; a[1].u.ki.dwFlags = flags | 2;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT))) == 2;
  }
  public static bool PressMouse(int button) {
    uint down = button == 4 ? 0x0080u : 0x0002u; uint up = button == 4 ? 0x0100u : 0x0004u; uint data = button == 4 ? 1u : 0u;
    if (button == 3) { down = 0x0020u; up = 0x0040u; }
    if (button == 5) { down = 0x0080u; up = 0x0100u; data = 2u; }
    INPUT[] a = new INPUT[2];
    a[0].type = 0; a[0].u.mi.dwFlags = down; a[0].u.mi.mouseData = data;
    a[1].type = 0; a[1].u.mi.dwFlags = up; a[1].u.mi.mouseData = data;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT))) == 2;
  }
  public static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  public static string ForegroundProcess() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }
}
"@
$mode = "manual"; $shotVk = 0x7A; $holdVk = 0x14; $interval = 2000; $inRaid = $false
$holding = $false; $lastSent = [DateTime]::MinValue; $fgLast = ""; $gLast = $null; $tick = 0
$gameNames = @("EscapeFromTarkov", "EscapeFromTarkovArena", "EscapeFromTarkov_BE", "EscapeFromTarkovArena_BE")
function Game-InFront { return ($gameNames -contains [TkInput]::ForegroundProcess()) }
function Send-Shot {
  $fg = [TkInput]::ForegroundProcess()
  if ($gameNames -notcontains $fg) { [Console]::Out.WriteLine("skip-foreground " + $fg); return }
  $ok = $false
  if ($shotVk -eq 4) { $ok = [TkInput]::PressMouse(3) }
  elseif ($shotVk -eq 5) { $ok = [TkInput]::PressMouse(4) }
  elseif ($shotVk -eq 6) { $ok = [TkInput]::PressMouse(5) }
  else { $ok = [TkInput]::Press([uint16]$shotVk) }
  if ($ok) { [Console]::Out.WriteLine("sent") } else { [Console]::Out.WriteLine("err SendInput failed") }
  $script:lastSent = [DateTime]::UtcNow
}
[Console]::Out.WriteLine("ready")
$in = [Console]::In
# stdin is a pipe: read it asynchronously so the poll loop never blocks.
$pending = $in.ReadLineAsync()
while ($true) {
  while ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { exit 0 }
    $p = $line.Trim().Split(" ")
    switch ($p[0]) {
      "cfg" { $mode = $p[1]; $shotVk = [int]$p[2]; $holdVk = [int]$p[3]; $interval = [int]$p[4]; [Console]::Out.WriteLine("cfg-ok " + $mode) }
      "raid" { $inRaid = ($p[1] -eq "1") }
      "press" { Send-Shot }
      "quit" { exit 0 }
    }
    $pending = $in.ReadLineAsync()
  }
  $tick++
  if (($tick % 5) -eq 0) { $fgNow = [TkInput]::ForegroundProcess(); if ($fgNow -ne $fgLast) { $fgLast = $fgNow; [Console]::Out.WriteLine("fg " + $fgNow) } }
  if (($tick % 50) -eq 1) { $gNow = [bool](Get-Process -Name EscapeFromTarkov, EscapeFromTarkovArena -ErrorAction SilentlyContinue); if ($gNow -ne $gLast) { $gLast = $gNow; [Console]::Out.WriteLine("game " + $(if ($gNow) { "1" } else { "0" })) } }
  $now = [DateTime]::UtcNow
  $due = ($now - $lastSent).TotalMilliseconds -ge $interval
  if ($mode -eq "hold") {
    $h = [TkInput]::Held($holdVk)
    if ($h -and -not $holding) { $holding = $true; [Console]::Out.WriteLine("hold-start"); Send-Shot }
    elseif (-not $h -and $holding) { $holding = $false; [Console]::Out.WriteLine("hold-stop") }
    elseif ($h -and $due) { Send-Shot }
  } elseif ($mode -eq "timer") {
    if ($inRaid -and $due) { Send-Shot }
  } elseif ($mode -eq "auto") {
    if ($due -and (Game-InFront)) { Send-Shot }
  }
  Start-Sleep -Milliseconds 100
}
`;

export class KeySender extends EventEmitter {
  private child: ChildProcess | null = null;
  private cfg: KeySenderConfig = { ...DEFAULT_SENDER };
  private inRaid = false;
  private ready = false;

  start(): void {
    if (this.child) return;
    const ps = powershellExe();
    const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin!.write(HELPER_SCRIPT + "\n");
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) this.onLine(l.trim());
    });
    child.stderr!.on("data", (d) => this.emit("log", `helper: ${String(d).trim()}`));
    child.on("exit", (code) => {
      this.child = null;
      this.ready = false;
      this.emit("log", `key helper exited (${code})`);
    });
    child.on("error", (e) => this.emit("log", `key helper failed: ${e.message}`));
  }

  private onLine(l: string): void {
    if (!l) return;
    if (l === "ready") {
      this.ready = true;
      this.pushConfig();
      this.write(`raid ${this.inRaid ? 1 : 0}`);
    }
    this.emit("line", l);
    if (l === "sent") this.emit("sent");
  }

  private write(cmd: string): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(cmd + "\n");
  }

  configure(cfg: KeySenderConfig): void {
    this.cfg = { ...cfg };
    if (this.ready) this.pushConfig();
  }

  private pushConfig(): void {
    const shot = vkFor(this.cfg.screenshotKey) ?? VK.F11;
    const hold = vkFor(this.cfg.holdKey) ?? VK.CapsLock;
    this.write(`cfg ${this.cfg.mode} ${shot} ${hold} ${Math.max(500, this.cfg.intervalMs | 0)}`);
  }

  setInRaid(v: boolean): void {
    this.inRaid = v;
    this.write(`raid ${v ? 1 : 0}`);
  }

  pressOnce(): void {
    this.write("press");
  }

  stop(): void {
    this.write("quit");
    const c = this.child;
    this.child = null;
    setTimeout(() => {
      try {
        c?.kill();
      } catch {
        /* gone */
      }
    }, 500);
  }
}
