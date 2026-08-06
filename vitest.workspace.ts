import { defineWorkspace } from "vitest/config";

// 测试工作区：packages/* 下各包独立运行测试
export default defineWorkspace(["packages/*"]);
