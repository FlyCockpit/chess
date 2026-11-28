import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync } from "node:fs";
import { link, lstat, open, opendir, readFile, readlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const identityFields = z.strictObject({
  platform: z.enum(["linux", "darwin", "win32"]),
  pid: z.number().int().positive().max(0x7fffffff),
  birth: z.string().min(1).max(256),
  boot: z.string().min(1).max(256),
  machine: z.string().min(1).max(256),
  scope: z.string().min(1).max(256),
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function realId(value: string): boolean {
  return uuid.test(value) && !/^(?:0{32}|f{32})$/i.test(value.replaceAll("-", ""));
}
function validIdentity(value: z.infer<typeof identityFields>): boolean {
  if (value.platform === "linux")
    return (
      /^[1-9][0-9]*$/.test(value.birth) &&
      realId(value.boot) &&
      ((/^[a-f0-9]{32}$/.test(value.machine) && !/^(?:0{32}|f{32})$/.test(value.machine)) ||
        value.machine === `boot:${value.boot}`) &&
      /^pid:\[\d+\]$/.test(value.scope)
    );
  if (!realId(value.machine) || value.scope !== "system") return false;
  if (value.platform === "darwin")
    return (
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(
        value.birth,
      ) && realId(value.boot)
    );
  return /^[1-9][0-9]*$/.test(value.birth) && realId(value.boot);
}
const identitySchema = identityFields.refine(validIdentity);
export type ProcessIdentity = z.infer<typeof identitySchema>;
const ownerSchema = identityFields
  .extend({ version: z.literal(2), token: z.uuid() })
  .strict()
  .refine(validIdentity);
const MAX_GENERATIONS = 65_536;
export class RunnerLockError extends Error {
  constructor(readonly code: "LOCKED" | "STORAGE") {
    super(`RUNNER_LOCK_${code}`);
  }
}

async function command(file: string, args: string[]): Promise<string> {
  // Native identity helpers never inherit provider keys or runner credentials.
  const systemRoot =
    process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined;
  const env = systemRoot
    ? {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        PATH: join(systemRoot, "System32"),
      }
    : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" };
  const { stdout } = await run(file, args, {
    timeout: 10_000,
    maxBuffer: 16_384,
    windowsHide: true,
    env,
  });
  return stdout.trim();
}

/** Exact native creation identity. Missing tools/permissions/ambiguous results fail closed. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
    throw new RunnerLockError("STORAGE");
  if (process.platform === "linux") {
    // A namespace handle identifies the active namespace, but inherited procfs can
    // still expose outer numeric PIDs. Prove its view BEFORE any numeric lookup.
    const status = await readFile("/proc/self/status", "utf8");
    const nspid = /^NSpid:\s*([^\n]+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
    if (nspid?.length !== 1 || nspid[0] !== String(process.pid))
      throw new RunnerLockError("STORAGE");
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
    if (!realId(boot)) throw new RunnerLockError("STORAGE");
    let machine: string;
    try {
      machine = (await readFile("/etc/machine-id", "utf8")).trim().toLowerCase();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      machine = "";
    }
    // Missing/empty machine-id is common in Node containers. This explicit identity
    // proves only this boot, never cross-boot same-host evidence.
    if (!machine) machine = `boot:${boot}`;
    const scope = await readlink("/proc/self/ns/pid");
    if (!/^pid:\[\d+\]$/.test(scope)) throw new RunnerLockError("STORAGE");
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // procfs may hide a live PID. Only the kernel's ESRCH proves absence.
      try {
        process.kill(pid, 0);
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code === "ESRCH") return undefined;
        throw signalError;
      }
      throw new RunnerLockError("STORAGE");
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const birth = fields[19];
    if (!birth || !/^\d+$/.test(birth)) throw new RunnerLockError("STORAGE");
    const identity = identitySchema.parse({ pid, birth, boot, machine, scope, platform: "linux" });
    // Z/X have exited irrevocably even while a parent has not reaped the task.
    if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x") {
      // A Linux thread-group leader may exit before its peer threads. Only a
      // terminal singleton proves the whole process incapable of further work.
      if (!/^[1-9][0-9]*$/.test(fields[17] ?? "")) throw new RunnerLockError("STORAGE");
      if (fields[17] === "1") return undefined;
    }
    return identity;
  }
  if (process.platform === "darwin") {
    const boot = (await command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).toLowerCase();
    const machineText = await command("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const machine = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i.exec(machineText)?.[1]?.toLowerCase();
    if (!machine || !realId(machine) || !realId(boot)) throw new RunnerLockError("STORAGE");
    let output: string;
    try {
      output = await command("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "state="]);
    } catch {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
        throw error;
      }
      throw new RunnerLockError("STORAGE");
    }
    const match = /^(.{24})\s+([A-Za-z+<>NSEsLWXZTIDRU-]+)$/.exec(output);
    if (!match) throw new RunnerLockError("STORAGE");
    const identity = identitySchema.parse({
      pid,
      birth: match[1],
      boot,
      machine,
      scope: "system",
      platform: "darwin",
    });
    if (/^[ZX]/.test(match[2] ?? "")) return undefined;
    // ps birth has one-second precision. Equal births always remain LOCKED,
    // including an ambiguous same-second PID reuse; no age/clock inference.
    return identity;
  }
  if (process.platform === "win32") {
    // Exact FILETIME and boot GUID, not a clock-derived LastBootUpTime estimate.
    // The only interpolation is an already bounded numeric PID; no shell is used.
    const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CockpitIdentity {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr data, uint size, out uint returned);
  public static string Birth(int pid) {
    IntPtr h = OpenProcess(0x101000, false, pid);
    if (h == IntPtr.Zero) { int e=Marshal.GetLastWin32Error(); if (e==87) return null; throw new Win32Exception(e); }
    try { uint state=WaitForSingleObject(h,0); if (state==0) return null; if (state!=258) throw new Win32Exception(Marshal.GetLastWin32Error()); long b,e,k,u; if (!GetProcessTimes(h,out b,out e,out k,out u)) throw new Win32Exception(Marshal.GetLastWin32Error()); return b.ToString(System.Globalization.CultureInfo.InvariantCulture); }
    finally { CloseHandle(h); }
  }
  public static string Boot() {
    IntPtr p=Marshal.AllocHGlobal(32);
    try { uint n; if (NtQuerySystemInformation(90,p,32,out n)!=0 || n<16) throw new InvalidOperationException(); return ((Guid)Marshal.PtrToStructure(p,typeof(Guid))).ToString(); }
    finally { Marshal.FreeHGlobal(p); }
  }
}
'@
$b=[CockpitIdentity]::Birth(${pid}); if ($null -eq $b) { 'null'; exit }
$m=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
@{pid=${pid};birth=$b;boot=[CockpitIdentity]::Boot();machine=$m.ToLowerInvariant();scope='system';platform='win32'} | ConvertTo-Json -Compress`;
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const value: unknown = JSON.parse(
      await command(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]),
    );
    return value === null ? undefined : identitySchema.parse(value);
  }
  throw new RunnerLockError("STORAGE");
}

export async function ownerIsDead(
  owner: ProcessIdentity,
  current: ProcessIdentity,
  probe = processIdentity,
): Promise<boolean> {
  if (!validIdentity(owner) || !validIdentity(current)) throw new RunnerLockError("STORAGE");
  if (owner.platform !== current.platform || owner.machine !== current.machine)
    throw new RunnerLockError("STORAGE");
  if (owner.boot !== current.boot) {
    if (owner.machine.startsWith("boot:") || current.machine.startsWith("boot:"))
      throw new RunnerLockError("STORAGE");
    return true;
  }
  if (owner.scope !== current.scope) throw new RunnerLockError("STORAGE");
  const observed = await probe(owner.pid);
  if (!observed) return true;
  if (
    !validIdentity(observed) ||
    observed.pid !== owner.pid ||
    observed.platform !== current.platform ||
    observed.machine !== current.machine ||
    observed.boot !== current.boot ||
    observed.scope !== current.scope
  )
    throw new RunnerLockError("STORAGE");
  return observed.birth !== owner.birth;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const h = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function readOwner(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new RunnerLockError("STORAGE");
  const h = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const s = await h.stat();
    if (
      s.dev !== before.dev ||
      s.ino !== before.ino ||
      !s.isFile() ||
      s.size > 2048 ||
      (process.platform !== "win32" && (s.mode & 0o077 || s.uid !== process.getuid?.()))
    )
      throw new RunnerLockError("STORAGE");
    const buffer = Buffer.alloc(2049);
    const { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2048) throw new RunnerLockError("STORAGE");
    return ownerSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await h.close();
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink()) throw new RunnerLockError("STORAGE");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function nameHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
function machineHash(identity: ProcessIdentity): string {
  return nameHash(JSON.stringify([identity.platform, identity.machine]));
}
function namespaceHash(identity: ProcessIdentity): string {
  return nameHash(identity.scope).slice(0, 22);
}

/** Never inspect/delete root, successor, release or blocked names. Candidate names
 * alone identify even an empty/partial initializer; UUID names are never reused. */
async function collectCandidates(root: string, current: ProcessIdentity): Promise<void> {
  const prefix = `cp-candidate-${nameHash(basename(root)).slice(0, 32)}-`;
  const entries = await opendir(dirname(root));
  let scanned = 0;
  let retained = 0;
  for await (const entry of entries) {
    if (++scanned > 200_000) throw new RunnerLockError("STORAGE");
    if (!entry.name.startsWith(prefix)) continue;
    const match =
      /^(\d{1,10})-([A-Za-z0-9_-]{43})-([a-f0-9]{32})-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{43})-([a-f0-9]{32})\.tmp$/.exec(
        entry.name.slice(prefix.length),
      );
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      Number(match[1]) < 1 ||
      Number(match[1]) > 0x7fffffff
    )
      throw new RunnerLockError("STORAGE");
    const encodedBoot = match[3]!.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    if (!realId(encodedBoot)) throw new RunnerLockError("STORAGE");
    let dead = false;
    if (match[2] === machineHash(current)) {
      if (encodedBoot !== current.boot && !current.machine.startsWith("boot:")) dead = true;
      else if (encodedBoot === current.boot && match[4] === namespaceHash(current)) {
        const observed = await processIdentity(Number(match[1]));
        dead =
          !observed ||
          (machineHash(observed) === machineHash(current) &&
            observed.boot === current.boot &&
            namespaceHash(observed) === namespaceHash(current) &&
            nameHash(observed.birth) !== match[5]);
      }
    }
    if (dead) {
      const path = join(dirname(root), entry.name);
      try {
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 2048 ||
          (process.platform !== "win32" && (stat.mode & 0o077 || stat.uid !== process.getuid?.()))
        )
          throw new RunnerLockError("STORAGE");
        await unlink(path); // only the uniquely named candidate alias, never published evidence
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else if (++retained >= 128) throw new RunnerLockError("STORAGE");
  }
}

/**
 * Append-only ownership chain. Every predecessor has exactly one fixed successor slot.
 * Atomic hard-link publication exposes only fully initialized, synced records. Neither
 * acquisition nor release ever unlinks/renames a published generation. A stalled loser
 * can only follow the same successor; it cannot erase another owner's authority.
 */
export class RunnerLock {
  private released = false;
  private constructor(
    private readonly root: string,
    private readonly path: string,
    private readonly next: string,
    private readonly token: string,
  ) {}
  static async acquire(
    root: string,
    hooks: {
      /** Test-only crash/race seams; product callers never supply hooks. */
      opened?: () => Promise<void>;
      initialized?: () => Promise<void>;
      published?: () => Promise<void>;
      observed?: (generation: number) => Promise<void>;
    } = {},
  ): Promise<RunnerLock> {
    let temporary: string | undefined;
    try {
      const current = await processIdentity(process.pid);
      if (!current) throw new RunnerLockError("STORAGE");
      await collectCandidates(root, current);
      const owner = { ...current, version: 2 as const, token: randomUUID() };
      temporary = join(
        dirname(root),
        `cp-candidate-${nameHash(basename(root)).slice(0, 32)}-${current.pid}-${machineHash(current)}-${current.boot.replaceAll("-", "")}-${namespaceHash(current)}-${nameHash(current.birth)}-${owner.token.replaceAll("-", "")}.tmp`,
      );
      if (Buffer.byteLength(basename(temporary)) > 255) throw new RunnerLockError("STORAGE");
      const h = await open(temporary, "wx", 0o600);
      try {
        await hooks.opened?.();
        await h.writeFile(JSON.stringify(owner));
        await h.sync();
      } finally {
        await h.close();
      }
      await hooks.initialized?.();
      let path = root;
      for (let i = 0; i < MAX_GENERATIONS; i++) {
        try {
          await link(temporary, path);
          await hooks.published?.();
          await syncDirectory(dirname(root));
          const next = `${root}.${createHash("sha256").update(owner.token).digest("hex")}.next`;
          return new RunnerLock(root, path, next, owner.token);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const previous = await readOwner(path);
        const next = `${root}.${createHash("sha256").update(previous.token).digest("hex")}.next`;
        if (await exists(`${path}.released`)) {
          if ((await readOwner(`${path}.released`)).token !== previous.token)
            throw new RunnerLockError("STORAGE");
        } else if (!(await ownerIsDead(previous, current))) throw new RunnerLockError("LOCKED");
        await hooks.observed?.(i);
        path = next;
      }
      throw new RunnerLockError("STORAGE");
    } catch (e) {
      if (e instanceof RunnerLockError) throw e;
      throw new RunnerLockError("STORAGE");
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }
  async fenced(): Promise<boolean> {
    return exists(`${this.root}.blocked`);
  }
  /** Permanent settlement-violation intent, published before any fallible ledger rewrite. */
  async fence(): Promise<void> {
    try {
      await link(this.path, `${this.root}.blocked`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncDirectory(dirname(this.root));
  }
  async check(): Promise<void> {
    if (
      this.released ||
      (await readOwner(this.path)).token !== this.token ||
      (await exists(this.next)) ||
      (await exists(`${this.path}.released`))
    )
      throw new RunnerLockError("STORAGE");
  }
  /** No yield after caller's cancellation guard: limits shutdown relies on this ordering. */
  releaseSync(before = () => {}, after = () => {}): void {
    if (this.released) {
      after();
      return;
    }
    let directory: number | undefined;
    try {
      // Link the immutable owner itself as its release marker, after the guard.
      // No temporary lock/reaper guard is ever installed.
      before();
      linkSync(this.path, `${this.path}.released`);
      this.released = true;
      try {
        if (process.platform !== "win32") {
          directory = openSync(dirname(this.path), constants.O_RDONLY);
          fsyncSync(directory);
        }
      } finally {
        after();
      }
    } finally {
      if (directory !== undefined) closeSync(directory);
    }
  }
  async release(): Promise<void> {
    await this.check();
    this.releaseSync();
  }
}
