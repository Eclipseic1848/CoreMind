/** 剥离私有上下文旁挂数据，保留原始事实与其他公开字段。 */
export function stripPrivateSkillPayload<T>(kind: string, payload: T): T {
  const fields =
    kind === "start"
      ? ["skillSnapshot", "toolDiscoveryCatalog", "toolDiscoverySelection", "toolDiscoverySearch"]
      : kind === "event"
        ? ["skillLoad", "toolDiscoveryCatalog", "toolDiscoverySelection", "toolDiscoverySearch"]
        : [];
  if (
    fields.length === 0 ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !fields.some((field) => Object.hasOwn(payload, field))
  ) {
    return payload;
  }
  const publicPayload = { ...(payload as Record<string, unknown>) };
  for (const field of fields) delete publicPayload[field];
  return publicPayload as T;
}
