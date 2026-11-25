import * as fs from 'fs/promises';
import * as path from 'path';
import { isObj } from './usage';

export type Json = Record<string, unknown>;

export async function readJson(file: string): Promise<Json | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return isObj(parsed) ? parsed : undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

/** Like readJson, but any error (missing, unreadable, invalid JSON) yields undefined. */
export async function tryReadJson(file: string): Promise<Json | undefined> {
  return readJson(file).catch(() => undefined);
}

/** Writes via a temp file + rename so readers never see a half-written file. */
export async function atomicWriteJson(file: string, data: unknown, pretty = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch {
    // Windows can refuse to replace a file another process has open; fall back to an in-place write.
    await fs.writeFile(file, content, 'utf8');
    await fs.rm(tmp, { force: true });
  }
}

/** Overwrites the file's contents in place, so symlinks and hard links to it stay intact. */
export async function writeJsonInPlace(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function mtimeMs(p: string): Promise<number | undefined> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return undefined;
  }
}
