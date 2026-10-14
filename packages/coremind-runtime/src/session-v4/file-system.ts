/*!
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// 保留既有会话合同，避免依赖升级改变历史存储与恢复语义。
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  err,
  FileError,
  type FileInfo,
  type FileKind,
  type FileSystem,
  ok,
  type Result,
  toError,
} from "./types.js";

function resolvePath(cwd: string, path: string): string {
  let normalized = path;
  if (normalized === "~") {
    normalized = homedir();
  } else if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = join(homedir(), normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {}
  }
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}
function fileKindFromStats(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileKind | undefined {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return undefined;
}
function fileInfoFromStats(
  path: string,
  stats: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  },
): Result<FileInfo, FileError> {
  const kind = fileKindFromStats(stats);
  if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
  return ok({
    name: basename(path),
    path,
    kind,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
function toFileError(error: unknown, fallbackPath?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  const nodeError = isNodeError(error) ? error : undefined;
  const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
  if (nodeError) {
    const message = nodeError.message;
    switch (nodeError.code) {
      case "ABORT_ERR":
        return new FileError("aborted", message, path, cause);
      case "ENOENT":
        return new FileError("not_found", message, path, cause);
      case "EACCES":
      case "EPERM":
        return new FileError("permission_denied", message, path, cause);
      case "ENOTDIR":
        return new FileError("not_directory", message, path, cause);
      case "EISDIR":
        return new FileError("is_directory", message, path, cause);
      case "EINVAL":
        return new FileError("invalid", message, path, cause);
    }
  }
  return new FileError("unknown", cause.message, path, cause);
}
function abortResult<TValue>(
  signal: AbortSignal | undefined,
  path?: string,
): Result<TValue, FileError> | undefined {
  return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}
export class SessionFileSystem implements FileSystem {
  cwd: string;
  constructor(options: {
    cwd: string;
  }) {
    this.cwd = options.cwd;
  }
  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(resolvePath(this.cwd, path));
  }
  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(join(...parts));
  }
  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<string>(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<void>(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
      if (afterMkdirAbort) return afterMkdirAbort;
      await writeFile(resolved, content, { signal: abortSignal });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolve(resolved, ".."), { recursive: true });
      await appendFile(resolved, content);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async renameFile(
    sourcePath: string,
    destinationPath: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>> {
    const source = resolvePath(this.cwd, sourcePath);
    const destination = resolvePath(this.cwd, destinationPath);
    const aborted = abortResult<void>(abortSignal, destination);
    if (aborted) return aborted;
    try {
      await rename(source, destination);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, source));
    }
  }
  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      return fileInfoFromStats(resolved, await lstat(resolved));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    const resolved = resolvePath(this.cwd, path);
    const aborted = abortResult<FileInfo[]>(abortSignal, resolved);
    if (aborted) return aborted;
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const infos: FileInfo[] = [];
      for (const entry of entries) {
        const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
        if (loopAbort) return loopAbort;
        const entryPath = resolve(resolved, entry.name);
        try {
          const info = fileInfoFromStats(entryPath, await lstat(entryPath));
          if (info.ok) infos.push(info.value);
        } catch (error) {
          return err(toFileError(error, entryPath));
        }
      }
      return ok(infos);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async exists(path: string): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path);
    if (result.ok) return ok(true);
    if (result.error.code === "not_found") return ok(false);
    return err(result.error);
  }
  async createDir(
    path: string,
    options?: {
      recursive?: boolean;
    },
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await mkdir(resolved, { recursive: options?.recursive ?? true });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
  async remove(
    path: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
    },
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePath(this.cwd, path);
    try {
      await rm(resolved, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }
}
