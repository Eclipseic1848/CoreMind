export const knowledgeAuthorizationEnv = "COREMIND_KNOWLEDGE_AUTHORIZATION";

export function knowledgeEndpoint() {
  const url = new URL(process.env.KNOWLEDGE_MCP_URL ?? "http://127.0.0.1:8767/mcp");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("知识示例需要不含用户名和密码的 127.0.0.1 HTTP MCP 地址");
  }
  const authorization = process.env[knowledgeAuthorizationEnv];
  if (!authorization?.startsWith("Bearer ") || !authorization.slice(7).trim()) {
    throw new Error(`请将 ${knowledgeAuthorizationEnv} 设置为完整的 Bearer 读令牌`);
  }
  return { url, authorization };
}
