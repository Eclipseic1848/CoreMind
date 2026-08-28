// 测试配置只引用该固定假值，避免在版本库中保存明文 Provider 凭据。
process.env.COREMIND_TEST_API_KEY = "test-only";
process.env.DEEPSEEK_API_KEY = "test-only";
