/** 极简参数解析：--flag / --flag=value / --flag value（值为字符串）/ positional */
export interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        // 布尔 flag：后一个参数不是 flag 时视为其值
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(name, next);
          i += 1;
        } else {
          flags.set(name, true);
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      flags.set(arg.slice(1), true);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

/** 读取字符串 flag */
export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** 读取布尔 flag */
export function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) !== undefined;
}

/** 读取数值 flag */
export function flagNumber(parsed: ParsedArgs, name: string): number | undefined {
  const value = parsed.flags.get(name);
  if (typeof value !== "string") return undefined;
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? undefined : num;
}
