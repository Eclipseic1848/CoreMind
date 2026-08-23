/** Tool Capability Fact 与 Tool Call 共享的稳定身份键。 */
export function toolCapabilityCallKey(
  agent: string,
  stepId: string | undefined,
  callId: string,
): string {
  return `${agent}\u0000${stepId ?? ""}\u0000${callId}`;
}
