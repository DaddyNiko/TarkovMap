import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { HELPER_SCRIPT, powershellExe } from "../src/key-sender.js";

/** The resident helper must keep polling while it waits for commands: a "game 0|1" report
 *  within seconds of "ready", with no command sent at all. (Console.In.ReadLineAsync blocks on a
 *  pipe; the reader lives on its own runspace so the poll loop never stalls.) */
describe("key helper process", () => {
  it("reports game state without being prompted", async () => {
    const c = spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines: string[] = [];
    const got = new Promise<string>((res) => {
      c.stdout.on("data", (d) => {
        for (const l of String(d).split(/\r?\n/)) if (l.trim()) lines.push(l.trim());
        const g = lines.find((l) => l.startsWith("game "));
        if (g) res(g);
      });
    });
    c.stdin.write(HELPER_SCRIPT + "\n");
    const timeout = new Promise<string>((res) => setTimeout(() => res("timeout: " + lines.join(" | ")), 15000));
    const first = await Promise.race([got, timeout]);
    c.stdin.write("quit\n");
    setTimeout(() => c.kill(), 500);
    expect(first).toMatch(/^game [01]$/);
    expect(lines[0]).toBe("ready");
  }, 20000);
});
