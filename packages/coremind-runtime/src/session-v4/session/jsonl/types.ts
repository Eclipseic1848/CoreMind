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
import type { FileError, FileSystem, Result } from "../../types.js";
import type { JsonValue, SessionCreateOptions, SessionMetadata } from "../types.js";
export type JsonlSessionRepoFileSystem = Pick<
  FileSystem,
  | "absolutePath"
  | "joinPath"
  | "readTextFile"
  | "writeFile"
  | "appendFile"
  | "renameFile"
  | "fileInfo"
  | "listDir"
  | "exists"
  | "createDir"
  | "remove"
> & {
  repairTextTail?(
    path: string,
    originalText: string,
    validPrefix: string,
  ): Promise<Result<void, FileError>>;
};
export interface JsonlSessionRepoOptions {
  fs: JsonlSessionRepoFileSystem;
  sessionsRoot: string;
}
export interface JsonlSessionMetadata extends SessionMetadata {
  cwd: string;
  path: string;
  modifiedAt: number;
  sourceFormat: 3 | 4;
  legacyParentSessionPath?: string;
  metadata?: Record<string, JsonValue>;
}
export interface JsonlSessionCreateOptions extends SessionCreateOptions {
  cwd: string;
  metadata?: Record<string, JsonValue>;
}
export interface JsonlSessionListOptions {
  cwd?: string;
}
export interface JsonlV4Header {
  kind: "header";
  version: 4;
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  metadata?: Record<string, JsonValue>;
}
