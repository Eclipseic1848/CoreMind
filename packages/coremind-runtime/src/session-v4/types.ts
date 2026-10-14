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
export type Result<TValue, TError> =
  | {
      ok: true;
      value: TValue;
    }
  | {
      ok: false;
      error: TError;
    };
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}
export type FileKind = "file" | "directory" | "symlink";
export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";
export class FileError extends Error {
  public code: FileErrorCode;
  public path?: string;
  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
}
export type CompactionErrorCode = "aborted" | "summarization_failed";
export class CompactionError extends Error {
  public code: CompactionErrorCode;
  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}
export interface FileInfo {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
}
export interface FileSystem {
  cwd: string;
  absolutePath(path: string): Promise<Result<string, FileError>>;
  joinPath(parts: string[]): Promise<Result<string, FileError>>;
  readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>>;
  renameFile(
    sourcePath: string,
    destinationPath: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  fileInfo(path: string): Promise<Result<FileInfo, FileError>>;
  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
  exists(path: string): Promise<Result<boolean, FileError>>;
  createDir(
    path: string,
    options?: {
      recursive?: boolean;
    },
  ): Promise<Result<void, FileError>>;
  remove(
    path: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
    },
  ): Promise<Result<void, FileError>>;
}
