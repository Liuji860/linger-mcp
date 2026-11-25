import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CachedSession {
  baseUrl: string;
  cookie: string;
  expiresAt: string;
  tenantId?: string;
  humanActorId?: string;
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  async load(expectedBaseUrl: string): Promise<CachedSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
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
      candidate.cookie.length === 0
    ) {
      return null;
    }

    const expiresAtMs = Date.parse(candidate.expiresAt);
    // Keep a 30-second buffer so near-expired cached cookies trigger clean re-login.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + 30_000) {
      return null;
    }

    return {
      baseUrl: candidate.baseUrl,
      cookie: candidate.cookie,
      expiresAt: candidate.expiresAt,
      tenantId: typeof candidate.tenantId === "string" ? candidate.tenantId : undefined,
      humanActorId: typeof candidate.humanActorId === "string" ? candidate.humanActorId : undefined,
    };
  }

  async save(session: CachedSession): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = join(dir, `.session.tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmpPath, JSON.stringify(session, null, 2), { mode: 0o600, encoding: "utf8" });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

export async function readMacOsKeychainPassword(service: string, account: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("LINGER_KEYCHAIN_SERVICE is only supported on macOS");
  }
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
