import { stripVTControlCharacters } from "node:util";

// biome-ignore lint/suspicious/noControlCharactersInRegex: 移除不可打印控制字符，保留 tab、CR 与 LF 原文分隔。
const nonPrintingControls = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/gu;

function normalize(value: string): string {
  return stripVTControlCharacters(value).replace(nonPrintingControls, "");
}

export function isSecretKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key|credential|client[_-]?secret/iu.test(
    normalize(key),
  );
}

export function redactSensitiveText(value: string): string {
  return normalize(value)
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/gu,
      "private-key-hidden",
    )
    .replace(/https?:\/\/[^\s"']+/giu, (url) => redactUrl(url))
    .replace(
      /(\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)[ \t]*:)[ \t]*[^ \t\r\n][^\r\n]*/giu,
      "$1 hidden",
    )
    .replace(
      /((?:["']?(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key|credential|client[_-]?secret)["']?\s*[:=]\s*|--?(?:api[_-]?key|token|secret|password|authorization)\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;{}[\]]+)/giu,
      "$1hidden",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1hidden")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/gu,
      "credential-hidden",
    );
}

export function redactUrl(value: string): string {
  const normalized = normalize(value);
  try {
    const url = new URL(normalized);
    let sensitive = Boolean(url.username || url.password);
    if (url.username) url.username = "hidden";
    if (url.password) url.password = "hidden";
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretKey(key)) {
        sensitive = true;
        url.searchParams.set(key, "hidden");
      }
    }
    return sensitive ? url.toString() : normalized;
  } catch {
    return normalized;
  }
}
