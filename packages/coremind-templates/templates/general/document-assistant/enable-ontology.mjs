import { writeFile } from "node:fs/promises";
import { loadConfigFile, parseAndValidate } from "coremind-ai";

const config = await loadConfigFile("coremind.yaml");
config.mcp.servers.ontology = {
  transport: "streamable-http",
  url: "http://127.0.0.1:8879/mcp",
  allowedAddresses: ["127.0.0.1"],
  headers: { Authorization: { env: "COREMIND_ONTOLOGY_AUTHORIZATION" } },
};
config.agents.main.tools.push({
  mcp: { server: "ontology", tool: "ontology_inspect_action" },
  effect: { operations: ["network"], reversible: true },
  capability: {
    effect: "network",
    replay: "safe",
    concurrency: "run_serial",
    checkpoint: "none",
    durability: "critical",
  },
});
parseAndValidate(config);
await writeFile("coremind-ontology.yaml", `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
