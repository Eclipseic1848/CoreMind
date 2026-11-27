// 固定百炼的 DeepSeek Flash 快照，使各业务两轮的模型版本可比较。
export const publicProvider = Object.freeze({
  id: "alibaba-model-studio",
  model: "deepseek-v4.1-flash-1017",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
