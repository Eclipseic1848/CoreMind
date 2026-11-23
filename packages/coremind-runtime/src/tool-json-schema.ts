import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

const options = {
  logger: false,
  strict: false,
  ownProperties: true,
} as const;
const draft07 = new Ajv(options);
const draft2020 = new Ajv2020(options);
const draft2020Uri = "https://json-schema.org/draft/2020-12/schema";

function usesDraft2020(schema: object): boolean {
  const dialect = (schema as { $schema?: unknown }).$schema;
  return dialect === draft2020Uri || dialect === `${draft2020Uri}#`;
}

export function validateToolSchema(schema: object): boolean {
  try {
    return (usesDraft2020(schema) ? draft2020 : draft07).validateSchema(schema) === true;
  } catch {
    return false;
  }
}

export function createToolSchemaValidator(schema: object): Ajv | Ajv2020 {
  return usesDraft2020(schema) ? new Ajv2020(options) : new Ajv(options);
}
