import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface Evidence {
  id: string;
  topic: string;
  finding: string;
}

export default {
  name: "search_knowledge",
  description: "从离线证据库查询与问题相关的证据",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  execute: async (_toolCallId: string, params: { query: string }) => {
    const file = fileURLToPath(new URL("../data/evidence.json", import.meta.url));
    const evidence = JSON.parse(await readFile(file, "utf8")) as Evidence[];
    const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = evidence.filter((item) =>
      terms.some((term) => `${item.topic} ${item.finding}`.toLowerCase().includes(term)),
    );
    const result = matched.length > 0 ? matched : evidence;
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  },
};
