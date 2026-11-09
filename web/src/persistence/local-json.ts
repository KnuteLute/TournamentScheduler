import { randomUUID } from 'crypto';
import { promises as fs, constants as fsConstants } from 'fs';
import * as path from 'path';

export class LocalJsonModeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalJsonModeRejectedError';
  }
}

export class LocalJsonCorruptError extends Error {
  constructor() {
    super('Local JSON data is corrupt; refusing to replace or reset it');
    this.name = 'LocalJsonCorruptError';
  }
}

export interface LocalJsonEnvironment {
  DB_MODE?: string;
  NODE_ENV?: string;
  VERCEL?: string;
  LOCAL_JSON_MODE?: string;
}

/** Fail closed unless local JSON is explicitly selected for single-process development. */
export function assertLocalJsonModeAllowed(env: LocalJsonEnvironment): void {
  const mode = (env.DB_MODE || '').toLowerCase();
  if (mode !== 'local' && mode !== 'offline') throw new LocalJsonModeRejectedError('Local JSON persistence is not selected');
  if (env.NODE_ENV === 'production' || env.VERCEL === '1' || env.VERCEL === 'true') {
    throw new LocalJsonModeRejectedError('Local JSON persistence is disabled in production/serverless environments');
  }
  if (env.LOCAL_JSON_MODE !== 'single-process') {
    throw new LocalJsonModeRejectedError('Set LOCAL_JSON_MODE=single-process to explicitly enable local JSON persistence');
  }
}

function safeLeafName(fileName: string): string {
  if (!fileName || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName || fileName.includes('\0')) {
    throw new TypeError('Local JSON filename must be a plain filename');
  }
  return fileName;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Private, single-process local JSON file access. Concurrent writers are
 * rejected by an exclusive lock; a stale lock after a crash requires operator
 * inspection and is never silently removed. Writes use a same-directory temp
 * file, fsync, a verified backup, atomic rename, and restrictive permissions.
 */
export class AtomicLocalJsonFile<T> {
  readonly filePath: string;
  private readonly lockPath: string;

  constructor(directory: string, fileName: string) {
    this.filePath = path.join(path.resolve(directory), safeLeafName(fileName));
    this.lockPath = `${this.filePath}.lock`;
  }

  async read(): Promise<T | null> {
    await this.ensurePrivateDirectory();
    try {
      const stat = await fs.lstat(this.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new LocalJsonModeRejectedError('Local data path must be a regular file');
      const input = await fs.open(this.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let raw: string;
      try {
        if (!(await input.stat()).isFile()) throw new LocalJsonModeRejectedError('Local data path must be a regular file');
        await input.chmod(0o600);
        raw = await input.readFile('utf8');
      } finally {
        await input.close();
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new LocalJsonCorruptError();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await this.ensurePrivateDirectory();
    const lock = await fs.open(this.lockPath, 'wx', 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new LocalJsonModeRejectedError('Another local JSON writer is active or left an operator-review lock');
      }
      throw error;
    });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    const backupTemporaryPath = `${backupPath}.${randomUUID()}.tmp`;
    try {
      const content = `${JSON.stringify(value, null, 2)}\n`;
      const output = await fs.open(temporaryPath, 'wx', 0o600);
      try {
        await output.writeFile(content, 'utf8');
        await output.sync();
      } finally {
        await output.close();
      }

      let existing = false;
      try {
        const stat = await fs.lstat(this.filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new LocalJsonModeRejectedError('Local data path must be a regular file');
        existing = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing) {
        const source = await fs.open(this.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let previousData: Buffer;
        try {
          if (!(await source.stat()).isFile()) throw new LocalJsonModeRejectedError('Local data path must be a regular file');
          previousData = await source.readFile();
        } finally {
          await source.close();
        }
        const backup = await fs.open(backupTemporaryPath, 'wx', 0o600);
        try {
          await backup.writeFile(previousData);
          await backup.sync();
        } finally {
          await backup.close();
        }
        await fs.rename(backupTemporaryPath, backupPath);
      }
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
      await syncDirectory(path.dirname(this.filePath));
    } finally {
      await Promise.all([
        fs.unlink(temporaryPath).catch(() => undefined),
        fs.unlink(backupTemporaryPath).catch(() => undefined),
      ]);
      await lock.close();
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async ensurePrivateDirectory(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LocalJsonModeRejectedError('Local data directory must not be a symlink');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new LocalJsonModeRejectedError('Local data directory must be owned by the current user');
    }
    await fs.chmod(directory, 0o700);
  }
}
