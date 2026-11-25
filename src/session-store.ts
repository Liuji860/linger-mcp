import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SESSION_COOKIE_RE = /^teamhub_session=[^\s;,]+$/;

export interface CachedSession {
  baseUrl: string;
  email?: string;
  cookie: string;
  expiresAt: string;
  tenantId?: string;
  humanActorId?: string;
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  async load(expectedBaseUrl: string, expectedEmail?: string): Promise<CachedSession | null> {
    let raw: string;
    try {
      const st = await lstat(this.filePath);
      if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0) {
        return null;
      }
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const candidate = parsed as Partial<CachedSession>;
    if (
      typeof candidate.baseUrl !== "string" ||
      typeof candidate.cookie !== "string" ||
      typeof candidate.expiresAt !== "string" ||
      candidate.baseUrl !== expectedBaseUrl ||
      !SESSION_COOKIE_RE.test(candidate.cookie)
    ) {
      return null;
    }

    if (
      expectedEmail &&
      candidate.email &&
      candidate.email.toLowerCase() !== expectedEmail.toLowerCase()
    ) {
      return null;
    }
    if (expectedEmail && !candidate.email) {
      return null;
    }

    const expiresAtMs = Date.parse(candidate.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + 30_000) {
      return null;
    }

    return {
      baseUrl: candidate.baseUrl,
      email: typeof candidate.email === "string" ? candidate.email : undefined,
      cookie: candidate.cookie,
      expiresAt: candidate.expiresAt,
      tenantId: typeof candidate.tenantId === "string" ? candidate.tenantId : undefined,
      humanActorId: typeof candidate.humanActorId === "string" ? candidate.humanActorId : undefined,
    };
  }

  async save(session: CachedSession): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmpPath = join(dir, `.session.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      await writeFile(tmpPath, JSON.stringify(session, null, 2), {
        flag: "wx",
        mode: 0o600,
        encoding: "utf8",
      });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

function assertSafeKeychainArg(value: string, label: string): void {
  if (!value || value.startsWith("-") || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid ${label} for Keychain lookup`);
  }
}

export async function readMacOsKeychainPassword(service: string, account: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("LINGER_KEYCHAIN_SERVICE is only supported on macOS");
  }
  assertSafeKeychainArg(service, "service");
  assertSafeKeychainArg(account, "account");
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { timeout: 5000 }
  );
  const password = stdout.replace(/[\r\n]+$/, "");
  if (!password) {
    throw new Error(`Empty password returned from macOS Keychain for service "${service}"`);
  }
  return password;
}
