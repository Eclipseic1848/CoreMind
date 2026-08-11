/** CLI 主入口：解析参数 → 分发命令 → 返回退出码 */
export declare function main(argv: string[]): Promise<number>;

/** 极简参数解析：--flag / --flag=value / --flag value（值为字符串）/ positional */
export declare interface ParsedArgs {
    flags: Map<string, string | boolean>;
    positionals: string[];
}

export { }
