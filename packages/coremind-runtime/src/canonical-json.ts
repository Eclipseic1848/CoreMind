/** 对对象键排序并忽略 undefined，用于稳定指纹与幂等内容比较。 */
export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, "$", new WeakMap<object, string>());
}

function serializeCanonicalJson(
  value: unknown,
  path: string,
  seen: WeakMap<object, string>,
): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const previousPath = seen.get(value);
  if (previousPath !== undefined) {
    return `{${JSON.stringify("$coremindRef")}:${JSON.stringify(previousPath)}}`;
  }
  seen.set(value, path);
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => serializeCanonicalJson(item, `${path}/${index}`, seen))
      .join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson(item, `${path}/${escapePathSegment(key)}`, seen)}`,
    )
    .join(",")}}`;
}

function escapePathSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
