import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ToolExecutionError } from "coremind-tools";

interface Order {
  id: string;
  status: string;
  amount: number;
}

export default {
  name: "lookup_order",
  description: "按订单号查询离线模拟订单",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
  execute: async (_toolCallId: string, params: { orderId: string }) => {
    const dataFile = fileURLToPath(new URL("../data/orders.json", import.meta.url));
    const orders = JSON.parse(await readFile(dataFile, "utf8")) as Order[];
    const order = orders.find((item) => item.id === params.orderId);
    if (!order) throw new ToolExecutionError(`订单 ${params.orderId} 不存在`);
    return { content: [{ type: "text", text: JSON.stringify(order) }], details: order };
  },
};
