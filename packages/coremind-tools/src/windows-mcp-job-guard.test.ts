import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WINDOWS_MCP_GUARD_SHA256 } from "./windows-mcp-service-identity.js";

const execute = promisify(execFile);
const guard = fileURLToPath(new URL("./vendor/windows-mcp/guard.dll", import.meta.url));
const limit = 1_048_576;
const base = {
  nodePath: "C:\\node.exe",
  launcherPath: "C:\\service.mjs",
  servicePipeName: "coremind-mcp-service-01234567-0123-0123-0123-0123456789ab",
};
const config = (cwd = "C:\\workspace") => JSON.stringify({ ...base, cwd, hostEnv: {} });
const rawCwd = (value: string) =>
  `${JSON.stringify({ ...base, hostEnv: {} }).slice(0, -1)},"cwd":${value}}`;
const rawEnvironment = (value: string) =>
  `${JSON.stringify({ ...base, cwd: "C:\\workspace" }).slice(0, -1)},"hostEnv":${value}}`;
const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64");

const sharedScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$strict = [Text.UTF8Encoding]::new($false, $true)
$failed = [Collections.Generic.List[string]]::new()
$count = 0
try {
  $bytes = [IO.File]::ReadAllBytes($env:COREMIND_GUARD_ASSEMBLY)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  if ($hash -cne $env:COREMIND_GUARD_SHA256) { throw 'identity' }
  $type = [Reflection.Assembly]::Load($bytes).GetType('CoreMindMcpJob', $true)
  $rows = [IO.File]::ReadAllLines($env:COREMIND_GUARD_CASES, $strict)
`;
const finishScript = `
} catch { $failed.Add('harness') }
$names = if ($failed.Count) { '"' + [String]::Join('","', $failed.ToArray()) + '"' } else { '' }
[Console]::WriteLine('{"cases":' + $count + ',"failed":[' + $names + ']}')
if ($failed.Count) { exit 1 }
`;
const parseScript = `
  $parse = $type.GetMethod('ParseControl', [Reflection.BindingFlags]'NonPublic,Static')
  if ($null -eq $parse) { throw 'method' }
  foreach ($row in $rows) {
    $cells = $row.Split([char]9)
    if ($cells.Length -ne 5) { throw 'fixture' }
    $count++
    $accepted = $false
    try {
      $text = $strict.GetString([Convert]::FromBase64String($cells[1]))
      $control = $parse.Invoke($null, [object[]]@($text, ($cells[2] -ceq '1')))
      $accepted = $null -ne $control
      if ($accepted -and $cells[4] -cne '~') {
        $expected = $strict.GetString([Convert]::FromBase64String($cells[4]))
        $accepted = $control.GetType().GetField('Cwd').GetValue($control) -ceq $expected
      }
    } catch { $accepted = $false }
    if ($accepted -ne ($cells[3] -ceq '1')) { $failed.Add($cells[0]) }
  }
`;
const frameScript = `
  $read = $type.GetMethod('ReadFrame', [Reflection.BindingFlags]'Public,Static')
  if ($null -eq $read) { throw 'method' }
  foreach ($row in $rows) {
    $cells = $row.Split([char]9)
    if ($cells.Length -ne 7) { throw 'fixture' }
    $count++
    $stream = [IO.MemoryStream]::new([Convert]::FromBase64String($cells[2]), $false)
    try {
      if ($cells[0] -ceq 'pair') {
        $first = $strict.GetString([Convert]::FromBase64String($cells[3]))
        $second = $strict.GetString([Convert]::FromBase64String($cells[4]))
        if ($read.Invoke($null, [object[]]@($stream)) -cne $first) { throw 'first' }
        if ($stream.Position -ne [long]$cells[5]) { throw 'read_ahead' }
        if ($read.Invoke($null, [object[]]@($stream)) -cne $second) { throw 'second' }
        if ($stream.Position -ne [long]$cells[6]) { throw 'position' }
        if ($null -ne $read.Invoke($null, [object[]]@($stream))) { throw 'eof' }
      } else {
        $result = $null
        $failure = ''
        try { $result = $read.Invoke($null, [object[]]@($stream)) }
        catch {
          $problem = $_.Exception
          while ($null -ne $problem.InnerException) { $problem = $problem.InnerException }
          $failure = $problem.GetType().Name
        }
        if ($cells[4] -ceq '-') {
          if ($failure) { throw 'unexpected' }
          if ($cells[3] -ceq '~') {
            if ($null -ne $result) { throw 'not_null' }
          } else {
            $expected = $strict.GetString([Convert]::FromBase64String($cells[3]))
            if ($null -eq $result -or $result -cne $expected) { throw 'content' }
          }
        } elseif ($failure -cne $cells[4]) { throw 'error_type' }
        if ($stream.Position -ne [long]$cells[5]) { throw 'position' }
      }
    } catch { $failed.Add($cells[1]) }
    finally { $stream.Dispose() }
  }
`;

describe.skipIf(process.platform !== "win32")("Windows MCP 固定 guard 控制帧", () => {
  it("严格解析闭合形状、解码重复键并完整保留 Unicode", async () => {
    const cases: [string, string, boolean, boolean, string?][] = [
      ["config", config(), false, true, "C:\\workspace"],
      ["cancel", '{"cancel":true}', false, true],
      ["close", '{"close":true}', true, true],
      ["ascii-whitespace", ' \r\n{"cancel":true} \t', false, true],
      ["escaped-key", String.raw`{"can\u0063el":true}`, false, true],
      ["trailing-comma", '{"cancel":true,}', false, false],
      ["second-document", '{"cancel":true}{}', false, false],
      ["root-duplicate", String.raw`{"cancel":true,"can\u0063el":true}`, false, false],
      ["unknown-root", '{"cancel":true,"unknown":true}', false, false],
      ["missing-fields", '{"nodePath":"C:\\\\node.exe"}', false, false],
      ["false-bool", '{"cancel":false}', false, false],
      ["string-bool", '{"cancel":"true"}', false, false],
      ["boolean-suffix", '{"cancel":truex}', false, false],
      ["array-root", "[]", false, false],
      ["comment", '/*x*/{"cancel":true}', false, false],
      ["single-quotes", "{'cancel':true}", false, false],
      ["close-as-initial", '{"close":true}', false, false],
      ["cancel-as-close", '{"cancel":true}', true, false],
      ["null-env", rawEnvironment("null"), false, false],
      ["array-env", rawEnvironment("[]"), false, false],
      ["numeric-env", rawEnvironment('{"PATH":1}'), false, false],
      ["unknown-env", rawEnvironment('{"__type":"x"}'), false, false],
      ["env-duplicate", rawEnvironment(String.raw`{"PATH":"a","\u0050ATH":"b"}`), false, false],
      ["env-case-alias", rawEnvironment('{"path":"a","PATH":"b"}'), false, false],
      ["env-trailing-comma", rawEnvironment('{"PATH":"a",}'), false, false],
      [
        "env-escaped-key",
        rawEnvironment(String.raw`{"\u0050ATH":"a"}`),
        false,
        true,
        "C:\\workspace",
      ],
      ["bad-escape", rawCwd(String.raw`"\x"`), false, false],
      ["short-unicode", rawCwd(String.raw`"\u12"`), false, false],
      ["lone-surrogate", rawCwd(String.raw`"\ud800"`), false, false],
      ["raw-control", rawCwd('"bad\u0001"'), false, false],
      ["non-ascii-whitespace", '\u00a0{"cancel":true}', false, false],
      ["bom", '\ufeff{"cancel":true}', false, false],
    ];
    for (const cwd of ["C:\\中文 空格 & 目录", "C:\\👩🏽‍💻", 'C:\\引号"反斜杠\\末尾'])
      cases.push([`unicode-${cases.length}`, config(cwd), false, true, cwd]);
    const rows = cases.map(([name, line, closing, accepts, cwd]) =>
      [
        name,
        encoded(line),
        closing ? "1" : "0",
        accepts ? "1" : "0",
        cwd === undefined ? "~" : encoded(cwd),
      ].join("\t"),
    );
    await checkAssembly(parseScript, rows);
  });

  it("按 UTF8 字节限制帧并拒绝坏输入，首帧不预读下一帧", async () => {
    const rows: string[] = [];
    const frame = (
      name: string,
      bytes: Buffer,
      value: string | null,
      error: string,
      position: number,
    ) =>
      rows.push(
        [
          "frame",
          name,
          bytes.toString("base64"),
          value === null ? "~" : encoded(value),
          error,
          position,
          0,
        ].join("\t"),
      );
    frame("empty-eof", Buffer.alloc(0), null, "-", 0);
    frame("empty-frame", Buffer.from("\n"), "", "-", 1);
    frame("partial-eof", Buffer.from("abc"), null, "InvalidOperationException", 3);
    for (const [name, bytes] of [
      ["continuation", [0xc3, 0x28, 10]],
      ["overlong", [0xc0, 0xaf, 10]],
      ["truncated", [0xe2, 0x82, 10]],
      ["surrogate", [0xed, 0xa0, 0x80, 10]],
    ] as const)
      frame(name, Buffer.from(bytes), null, "DecoderFallbackException", bytes.length);
    const ascii = "a".repeat(limit);
    const multibyte = `${"中".repeat(Math.floor(limit / 3))}a`;
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(limit);
    frame("exact-ascii", Buffer.from(`${ascii}\n`), ascii, "-", limit + 1);
    frame("exact-multibyte", Buffer.from(`${multibyte}\n`), multibyte, "-", limit + 1);
    frame(
      "unicode",
      Buffer.from("汉字👩🏽‍💻\n"),
      "汉字👩🏽‍💻",
      "-",
      Buffer.byteLength("汉字👩🏽‍💻\n"),
    );
    frame("overflow", Buffer.from(`${ascii}a\n`), null, "InvalidOperationException", limit + 1);
    frame("cr-counts", Buffer.from(`${ascii}\r\n`), null, "InvalidOperationException", limit + 1);
    frame("crlf", Buffer.from("{}\r\n"), "{}\r", "-", 4);
    const first = '{"cancel":true}';
    const second = '{"close":true}';
    const both = `${first}\n${second}\n`;
    rows.push(
      [
        "pair",
        "no-read-ahead",
        encoded(both),
        encoded(first),
        encoded(second),
        Buffer.byteLength(first) + 1,
        Buffer.byteLength(both),
      ].join("\t"),
    );
    await checkAssembly(frameScript, rows);
  });
});

async function checkAssembly(script: string, rows: string[]) {
  const windows = process.env.SystemRoot ?? process.env.windir;
  if (!windows || !path.win32.isAbsolute(windows)) throw new Error("缺少系统 Windows 目录");
  expect(
    createHash("sha256")
      .update(await readFile(guard))
      .digest("hex"),
  ).toBe(WINDOWS_MCP_GUARD_SHA256);
  const prefix = "coremind-mcp-guard-frames-";
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  let failed: unknown;
  try {
    const cases = path.join(directory, "cases.tsv");
    await writeFile(cases, `${rows.join("\n")}\n`, "utf8");
    // 原文只经 UTF8/base64 夹具传递，固定脚本不插值路径、JSON 或环境值。
    const command = Buffer.from(sharedScript + script + finishScript, "utf16le").toString("base64");
    const result = await execute(
      path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", command],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          SystemRoot: windows,
          windir: windows,
          TEMP: tmpdir(),
          TMP: tmpdir(),
          COREMIND_GUARD_ASSEMBLY: guard,
          COREMIND_GUARD_SHA256: WINDOWS_MCP_GUARD_SHA256,
          COREMIND_GUARD_CASES: cases,
        },
      },
    );
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({ cases: rows.length, failed: [] });
  } catch (error) {
    failed = error;
  }
  try {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith(prefix)
    )
      throw new Error("拒绝清理不属于本测试的临时目录");
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    if (failed) throw new AggregateError([failed, error], "guard 验证与临时目录清理失败");
    throw error;
  }
  if (failed) throw failed;
}
