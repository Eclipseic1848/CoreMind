/** 从声明的点分隔字段路径读取非空字符串，供 Policy 与 Checkpoint 共享。 */
export function collectDeclaredStringFields(value: unknown, fields: readonly string[]): string[] {
  const values: string[] = [];
  for (const field of fields) {
    let current: unknown = value;
    for (const segment of field.split(".")) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (typeof current === "string" && current.length > 0) values.push(current);
  }
  return values;
}
