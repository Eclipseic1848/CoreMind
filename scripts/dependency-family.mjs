import { readFile } from "node:fs/promises";
import path from "node:path";

const DIRECT_MEMBERS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];
export const DEPENDENCY_FAMILY = Object.freeze([
  ...DIRECT_MEMBERS,
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
]);

export function declaredFamilyVersion(manifests) {
  const declarations = DIRECT_MEMBERS.flatMap((name) => {
    const versions = manifests.map((manifest) => manifest.dependencies?.[name]).filter(Boolean);
    if (!versions.length) throw new Error(`缺少直接依赖声明：${name}`);
    return versions;
  });
  const versions = [...new Set(declarations)];
  if (versions.length !== 1 || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u.test(versions[0]))
    throw new Error("直接核心依赖必须声明同一个精确版本");
  return versions[0];
}

export function assertNpmDependencyFamily(graph, expectedVersion) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || graph.error)
    throw new Error("npm 安装图无效");
  const versions = new Map(DEPENDENCY_FAMILY.map((name) => [name, new Set()]));
  const pending = [["", graph]];
  while (pending.length) {
    const [name, node] = pending.pop();
    if (
      !node ||
      typeof node !== "object" ||
      node.missing ||
      node.invalid ||
      node.extraneous ||
      (Array.isArray(node.problems) && node.problems.length)
    )
      throw new Error("npm 安装图包含缺失、无效或额外依赖");
    if (versions.has(name)) {
      if (typeof node.version !== "string") throw new Error(`安装图缺少版本：${name}`);
      versions.get(name).add(node.version);
    }
    for (const entry of Object.entries(node.dependencies ?? {})) pending.push(entry);
  }
  const family = DEPENDENCY_FAMILY.map((name) => ({
    name,
    versions: [...versions.get(name)].sort(),
  }));
  if (
    !expectedVersion ||
    family.some((entry) => entry.versions.length !== 1 || entry.versions[0] !== expectedVersion)
  )
    throw new Error("消费者核心依赖族缺失或版本漂移");
  return { packages: family.length, version: expectedVersion, family };
}

/** 核对真实安装 metadata；bundled 只根据实际输出贡献判断，不把已解析等同已内联。 */
export async function buildWorkerRuntimeDependencies(rootDirectory, metafile, expectedVersion) {
  const root = path.resolve(rootDirectory);
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const locations = [];
  /** @type {Record<string, { version: string, integrity: string, bundled: boolean }>} */
  const result = {};
  for (const name of DEPENDENCY_FAMILY) {
    const suffix = `node_modules/${name}`;
    const entries = Object.entries(lock.packages ?? {}).filter(
      ([relative]) => relative === suffix || relative.endsWith(`/${suffix}`),
    );
    if (!entries.length) throw new Error(`锁定安装缺少核心依赖：${name}`);
    for (const [relative, locked] of entries) {
      const metadata = JSON.parse(
        await readFile(path.join(root, relative, "package.json"), "utf8"),
      );
      if (
        metadata.name !== name ||
        metadata.version !== locked.version ||
        locked.version !== expectedVersion ||
        typeof locked.integrity !== "string" ||
        !locked.integrity.startsWith("sha512-")
      )
        throw new Error(`核心依赖实际安装身份与 lock 不一致：${name}`);
      const previous = result[name];
      if (previous && previous.integrity !== locked.integrity)
        throw new Error(`同版本核心依赖存在不同来源身份：${name}`);
      result[name] = { version: metadata.version, integrity: locked.integrity, bundled: false };
      locations.push({ name, relative });
    }
  }
  locations.sort((left, right) => right.relative.length - left.relative.length);
  for (const output of Object.values(metafile?.outputs ?? {})) {
    for (const [input, contribution] of Object.entries(output.inputs ?? {})) {
      if (!(contribution.bytesInOutput > 0)) continue;
      const relative = path.relative(root, path.resolve(root, input)).split(path.sep).join("/");
      // 最长安装路径先匹配，避免把嵌套包的代码错误归到它的父包。
      const owner = locations.find(
        (entry) =>
          relative.startsWith(`${entry.relative}/`) &&
          !relative.slice(entry.relative.length + 1).includes("node_modules/"),
      );
      if (owner) result[owner.name].bundled = true;
    }
  }
  if (!Object.values(result).some((entry) => entry.bundled))
    throw new Error("Worker 未记录任何核心依赖的真实输出贡献");
  return result;
}
