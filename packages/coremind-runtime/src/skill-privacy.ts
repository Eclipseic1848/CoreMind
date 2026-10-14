/** 仅剥离技能私有旁挂数据，保留原始事实与其他公开字段。 */
export function stripPrivateSkillPayload<T>(kind: string, payload: T): T {
  const field = kind === "start" ? "skillSnapshot" : kind === "event" ? "skillLoad" : undefined;
  if (
    !field ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Object.hasOwn(payload, field)
  ) {
    return payload;
  }
  const publicPayload = { ...(payload as Record<string, unknown>) };
  delete publicPayload[field];
  return publicPayload as T;
}
