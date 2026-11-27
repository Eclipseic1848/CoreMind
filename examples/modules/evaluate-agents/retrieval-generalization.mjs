import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function runRetrievalCases({ seed }) {
  const model = process.env.COREMIND_RETRIEVAL_MODEL_DIR;
  if (!model) throw new Error("检索泛化评测需要本地模型目录 COREMIND_RETRIEVAL_MODEL_DIR");
  const python =
    process.env.COREMIND_RETRIEVAL_PYTHON || process.env.COREMIND_ONTOLOGY_PYTHON || "python";
  const { stdout } = await execute(
    python,
    [
      "-B",
      "-X",
      "utf8",
      path.join(import.meta.dirname, "retrieval-generalization.py"),
      "--seed",
      String(seed),
      "--model-dir",
      path.resolve(model),
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  return JSON.parse(stdout);
}
