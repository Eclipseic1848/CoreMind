import { pathToFileURL } from "node:url";
import { runSkillInstaller } from "../../../packages/coremind-templates/bin/install-skill.mjs";

export { checkId, installSkill } from "../../../packages/coremind-templates/bin/install-skill.mjs";

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runSkillInstaller(process.argv.slice(2));
}
