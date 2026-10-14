// 固定来源的私有 Linux 安全后端；由构建脚本生成，请勿手工修改。

// node_modules/@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js
function quote(args) {
  return args.map((arg) => {
    if (arg === "") {
      return "''";
    }
    if (/^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(arg)) {
      return arg;
    }
    return "'" + arg.replace(/'/g, `'"'"'`) + "'";
  }).join(" ");
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/utils/debug.js
function logForDebugging(message, options) {
  if (!process.env.SRT_DEBUG) {
    return;
  }
  const level = options?.level || "info";
  const prefix = "[SandboxDebug]";
  switch (level) {
    case "error":
      console.error(`${prefix} ${message}`);
      break;
    case "warn":
      console.warn(`${prefix} ${message}`);
      break;
    default:
      console.error(`${prefix} ${message}`);
  }
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/utils/which.js
import { spawnSync } from "node:child_process";
function whichSync(bin) {
  if (typeof globalThis.Bun !== "undefined") {
    return globalThis.Bun.which(bin);
  }
  const result = spawnSync("which", [bin], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1e3
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js
import * as fs3 from "fs";
import { tmpdir } from "node:os";
import path2, { join as join3 } from "node:path";

// node_modules/@anthropic-ai/sandbox-runtime/dist/utils/ripgrep.js
import { spawn } from "child_process";
import { text } from "node:stream/consumers";
function hasRipgrepSync() {
  return whichSync("rg") !== null;
}
async function ripGrep(args, target, abortSignal, config = { command: "rg" }) {
  const { command, args: commandArgs = [], argv0 } = config;
  const child = spawn(command, [...commandArgs, ...args, target], {
    argv0,
    signal: abortSignal,
    timeout: 1e4,
    windowsHide: true
  });
  const [stdout, stderr, code] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    new Promise((resolve2, reject) => {
      child.on("close", resolve2);
      child.on("error", reject);
    })
  ]);
  if (code === 0) {
    return stdout.trim().split("\n").filter(Boolean);
  }
  if (code === 1) {
    return [];
  }
  throw new Error(`ripgrep failed with exit code ${code}: ${stderr}`);
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js
import { homedir } from "os";
import * as path from "path";
import * as fs from "fs";

// node_modules/@anthropic-ai/sandbox-runtime/dist/utils/platform.js
function getPlatform() {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js
var DANGEROUS_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json"
];
var DANGEROUS_DIRECTORIES = [".git", ".vscode", ".idea"];
function getDangerousDirectories() {
  return [
    ...DANGEROUS_DIRECTORIES.filter((d) => d !== ".git"),
    ".claude/commands",
    ".claude/agents"
  ];
}
function normalizeCaseForComparison(pathStr) {
  return pathStr.toLowerCase();
}
function containsGlobChars(pathPattern) {
  return pathPattern.includes("*") || pathPattern.includes("?") || pathPattern.includes("[") || pathPattern.includes("]");
}
function containsGlobCharsWin(p) {
  return p.includes("*") || p.includes("?");
}
function containsGlobCharsForPlatform(p) {
  return getPlatform() === "windows" ? containsGlobCharsWin(p) : containsGlobChars(p);
}
function stripExtendedPathPrefix(p) {
  if (/^\\\\\?\\unc\\/i.test(p))
    return "\\\\" + p.slice(8);
  if (p.startsWith("\\\\?\\"))
    return p.slice(4);
  return p;
}
function isUncPath(p) {
  const ns = path.win32.toNamespacedPath(p);
  return /^[\\/]{2}[?.][\\/]unc[\\/]/i.test(ns);
}
function isSymlinkOutsideBoundary(originalPath, resolvedPath) {
  const normalizedOriginal = path.normalize(originalPath);
  const normalizedResolved = path.normalize(resolvedPath);
  if (normalizedResolved === normalizedOriginal) {
    return false;
  }
  if (normalizedOriginal.startsWith("/tmp/") && normalizedResolved === "/private" + normalizedOriginal) {
    return false;
  }
  if (normalizedOriginal.startsWith("/var/") && normalizedResolved === "/private" + normalizedOriginal) {
    return false;
  }
  if (normalizedOriginal.startsWith("/private/tmp/") && normalizedResolved === normalizedOriginal) {
    return false;
  }
  if (normalizedOriginal.startsWith("/private/var/") && normalizedResolved === normalizedOriginal) {
    return false;
  }
  if (normalizedResolved === "/") {
    return true;
  }
  const resolvedParts = normalizedResolved.split("/").filter(Boolean);
  if (resolvedParts.length <= 1) {
    return true;
  }
  if (normalizedOriginal.startsWith(normalizedResolved + "/")) {
    return true;
  }
  let canonicalOriginal = normalizedOriginal;
  if (normalizedOriginal.startsWith("/tmp/")) {
    canonicalOriginal = "/private" + normalizedOriginal;
  } else if (normalizedOriginal.startsWith("/var/")) {
    canonicalOriginal = "/private" + normalizedOriginal;
  }
  if (canonicalOriginal !== normalizedOriginal && canonicalOriginal.startsWith(normalizedResolved + "/")) {
    return true;
  }
  const resolvedStartsWithOriginal = normalizedResolved.startsWith(normalizedOriginal + "/");
  const resolvedStartsWithCanonical = canonicalOriginal !== normalizedOriginal && normalizedResolved.startsWith(canonicalOriginal + "/");
  const resolvedIsCanonical = canonicalOriginal !== normalizedOriginal && normalizedResolved === canonicalOriginal;
  const resolvedIsSame = normalizedResolved === normalizedOriginal;
  if (!resolvedIsSame && !resolvedIsCanonical && !resolvedStartsWithOriginal && !resolvedStartsWithCanonical) {
    return true;
  }
  return false;
}
function expandTilde(p) {
  if (p === "~")
    return homedir();
  if (p.startsWith("~/") || process.platform === "win32" && p.startsWith("~\\")) {
    return homedir() + p.slice(1);
  }
  return p;
}
function expandWindowsEnvRefs(p) {
  const home = homedir();
  const drive = /^[A-Za-z]:/.test(home) ? home.slice(0, 2) : "";
  const homePath = drive ? home.slice(2) : home;
  return p.replace(/%USERPROFILE%/gi, home).replace(/%HOMEDRIVE%/gi, drive).replace(/%HOMEPATH%/gi, homePath);
}
function normalizePathForSandbox(pathPattern) {
  const cwd = process.cwd();
  if (getPlatform() === "windows") {
    pathPattern = stripExtendedPathPrefix(expandWindowsEnvRefs(pathPattern));
    if (/^[a-z]:/.test(pathPattern)) {
      pathPattern = pathPattern[0].toUpperCase() + pathPattern.slice(1);
    }
    if (isUncPath(pathPattern) && !containsGlobCharsWin(pathPattern)) {
      return path.win32.normalize(pathPattern);
    }
  }
  if (getPlatform() !== "windows" && pathPattern.endsWith("/") && pathPattern !== "/" && !containsGlobCharsForPlatform(pathPattern)) {
    pathPattern = pathPattern.replace(/\/+$/, "") || "/";
  }
  let normalizedPath = expandTilde(pathPattern);
  if (normalizedPath !== pathPattern) {
  } else if (pathPattern.startsWith("./") || pathPattern.startsWith("../")) {
    normalizedPath = path.resolve(cwd, pathPattern);
  } else if (!path.isAbsolute(pathPattern)) {
    normalizedPath = path.resolve(cwd, pathPattern);
  }
  if (containsGlobCharsForPlatform(normalizedPath)) {
    const splitRe = getPlatform() === "windows" ? /[*?]/ : /[*?[\]]/;
    const staticPrefix = normalizedPath.split(splitRe)[0];
    if (staticPrefix && staticPrefix !== "/") {
      const baseDir = staticPrefix.endsWith("/") ? staticPrefix.slice(0, -1) : path.dirname(staticPrefix);
      try {
        const resolvedBaseDir = fs.realpathSync(baseDir);
        if (!isSymlinkOutsideBoundary(baseDir, resolvedBaseDir)) {
          const patternSuffix = normalizedPath.slice(baseDir.length);
          return resolvedBaseDir + patternSuffix;
        }
      } catch {
      }
    }
    return normalizedPath;
  }
  try {
    const resolvedPath = fs.realpathSync(normalizedPath);
    if (isSymlinkOutsideBoundary(normalizedPath, resolvedPath)) {
    } else {
      normalizedPath = resolvedPath;
    }
  } catch {
  }
  return normalizedPath;
}
function getDefaultWritePaths() {
  const homeDir = homedir();
  const recommendedPaths = [
    "/dev/stdout",
    "/dev/stderr",
    "/dev/null",
    "/dev/tty",
    "/dev/dtracehelper",
    "/dev/autofs_nowait",
    "/tmp/claude",
    "/private/tmp/claude",
    path.join(homeDir, ".npm/_logs"),
    path.join(homeDir, ".claude/debug")
  ];
  return recommendedPaths;
}
var CA_TRUST_VARS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  // gcloud ignores SSL_CERT_FILE/REQUESTS_CA_BUNDLE; this is its dedicated
  // override (maps to core/custom_ca_certs_file).
  "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
  // Nix-built binaries are patched to read this instead of SSL_CERT_FILE, and
  // it's typically pre-set to the Nix system bundle in the parent env, so we
  // must override it explicitly.
  "NIX_SSL_CERT_FILE"
];
function generateProxyEnvVars(httpProxyPort, socksProxyPort, caCertPath, proxyAuthToken, skipTmpdir, encodedCommand) {
  const userRaw = proxyUsernameFor(encodedCommand);
  const userPct = userRaw === PROXY_AUTH_USER ? userRaw : encodeURIComponent(userRaw);
  const auth = proxyAuthToken ? `${userPct}:${proxyAuthToken}@` : "";
  const envVars = [`SANDBOX_RUNTIME=1`];
  if (!skipTmpdir) {
    const tmpdir2 = process.env.CLAUDE_CODE_TMPDIR || process.env.CLAUDE_TMPDIR || "/tmp/claude";
    envVars.push(`TMPDIR=${tmpdir2}`);
  }
  if (caCertPath) {
    for (const v of CA_TRUST_VARS) {
      envVars.push(`${v}=${caCertPath}`);
    }
  }
  if (!httpProxyPort && !socksProxyPort) {
    return envVars;
  }
  const noProxyAddresses = [
    "localhost",
    "127.0.0.1",
    "::1",
    "169.254.0.0/16",
    // Link-local
    "10.0.0.0/8",
    // Private network
    "172.16.0.0/12",
    // Private network
    "192.168.0.0/16"
    // Private network
  ].join(",");
  envVars.push(`NO_PROXY=${noProxyAddresses}`);
  envVars.push(`no_proxy=${noProxyAddresses}`);
  if (httpProxyPort) {
    envVars.push(`HTTP_PROXY=http://${auth}localhost:${httpProxyPort}`);
    envVars.push(`HTTPS_PROXY=http://${auth}localhost:${httpProxyPort}`);
    envVars.push(`http_proxy=http://${auth}localhost:${httpProxyPort}`);
    envVars.push(`https_proxy=http://${auth}localhost:${httpProxyPort}`);
    if (proxyAuthToken) {
      envVars.push(`GIT_CONFIG_PARAMETERS='http.proxyAuthMethod=basic'`);
    }
  }
  const connectProxyUrl = httpProxyPort ? `http://${auth}localhost:${httpProxyPort}` : `socks5h://${auth}localhost:${socksProxyPort}`;
  envVars.push(`ALL_PROXY=${connectProxyUrl}`);
  envVars.push(`all_proxy=${connectProxyUrl}`);
  envVars.push(`GRPC_PROXY=${connectProxyUrl}`);
  envVars.push(`grpc_proxy=${connectProxyUrl}`);
  if (socksProxyPort) {
    const sshMuxOverride = "-o ControlMaster=no -o ControlPath=none";
    const platform = getPlatform();
    if (platform === "macos") {
      envVars.push(`GIT_SSH_COMMAND=ssh ${sshMuxOverride} -o ProxyCommand='nc -X 5 -x localhost:${socksProxyPort} %h %p'`);
    } else if (platform === "linux" && httpProxyPort) {
      const socatAuth = proxyAuthToken ? `,proxyauth=${userRaw}:${proxyAuthToken}` : "";
      envVars.push(`GIT_SSH_COMMAND=ssh ${sshMuxOverride} -o ProxyCommand='socat - PROXY:localhost:%h:%p,proxyport=${httpProxyPort}${socatAuth}'`);
    }
    envVars.push(`FTP_PROXY=socks5h://${auth}localhost:${socksProxyPort}`);
    envVars.push(`ftp_proxy=socks5h://${auth}localhost:${socksProxyPort}`);
    envVars.push(`RSYNC_PROXY=localhost:${socksProxyPort}`);
    envVars.push(`DOCKER_HTTP_PROXY=http://${auth}localhost:${httpProxyPort || socksProxyPort}`);
    envVars.push(`DOCKER_HTTPS_PROXY=http://${auth}localhost:${httpProxyPort || socksProxyPort}`);
    if (httpProxyPort) {
      envVars.push(`CLOUDSDK_PROXY_TYPE=http`);
      envVars.push(`CLOUDSDK_PROXY_ADDRESS=localhost`);
      envVars.push(`CLOUDSDK_PROXY_PORT=${httpProxyPort}`);
      if (proxyAuthToken) {
        envVars.push(`CLOUDSDK_PROXY_USERNAME=${userRaw}`);
        envVars.push(`CLOUDSDK_PROXY_PASSWORD=${proxyAuthToken}`);
      }
    }
  }
  return envVars;
}
var SAFE_DIRECTORY_WILDCARD_THRESHOLD = 8;
function buildGitConfigEnv(opts) {
  if (opts.baseEnv?.GIT_CONFIG_COUNT === "0")
    return {};
  const parsed = Number.parseInt(opts.baseEnv?.GIT_CONFIG_COUNT ?? "", 10);
  const start = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  let n = start;
  const out = {};
  const emit = (key, value) => {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  };
  const dirs = [
    ...new Set(opts.safeDirs.filter((d) => !!d).map((d) => {
      const fwd = d.replace(/\\/g, "/");
      const stripped = fwd.replace(/\/+$/, "");
      if (stripped === "" || /^[A-Za-z]:$/.test(stripped)) {
        return `${stripped}/`;
      }
      return stripped;
    }))
  ];
  if (dirs.length > SAFE_DIRECTORY_WILDCARD_THRESHOLD) {
    emit("safe.directory", "*");
  } else {
    for (const d of dirs) {
      emit("safe.directory", d);
      emit("safe.directory", d.endsWith("/") ? `${d}*` : `${d}/*`);
    }
  }
  if (opts.schannelCa) {
    emit("http.schannelUseSSLCAInfo", "true");
    emit("http.schannelCheckRevoke", "false");
  }
  if (n === start)
    return {};
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}
function buildPosixGitSafeDirEnv(opts) {
  const baseEnv = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT
  };
  for (const k of opts.unsetEnvVars ?? [])
    delete baseEnv[k];
  Object.assign(baseEnv, opts.setEnvVars ?? {});
  return buildGitConfigEnv({ safeDirs: opts.safeDirs, baseEnv });
}
function encodeSandboxedCommand(command) {
  const truncatedCommand = command.slice(0, 100);
  return Buffer.from(truncatedCommand).toString("base64");
}
var PROXY_AUTH_USER = "srt";
function proxyUsernameFor(encodedCommand) {
  if (!encodedCommand)
    return PROXY_AUTH_USER;
  const user = `${PROXY_AUTH_USER}.${encodedCommand}`;
  return Buffer.byteLength(user) <= 255 ? user : PROXY_AUTH_USER;
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js
import { join as join2, dirname as dirname2 } from "node:path";
import { fileURLToPath } from "node:url";
import * as fs2 from "node:fs";
import { execSync } from "node:child_process";
import { homedir as homedir2 } from "node:os";
var applySeccompPathCache = /* @__PURE__ */ new Map();
var cachedGlobalNpmPaths = null;
function getGlobalNpmPaths() {
  if (cachedGlobalNpmPaths)
    return cachedGlobalNpmPaths;
  const paths = [];
  try {
    const npmRoot = execSync("npm root -g", {
      encoding: "utf8",
      timeout: 5e3,
      stdio: ["pipe", "pipe", "ignore"]
    }).trim();
    if (npmRoot) {
      paths.push(join2(npmRoot, "@anthropic-ai", "sandbox-runtime"));
    }
  } catch {
  }
  const home = homedir2();
  paths.push(
    // npm global (Linux/macOS)
    join2("/usr", "lib", "node_modules", "@anthropic-ai", "sandbox-runtime"),
    join2("/usr", "local", "lib", "node_modules", "@anthropic-ai", "sandbox-runtime"),
    // npm global with prefix (common on macOS with homebrew)
    join2("/opt", "homebrew", "lib", "node_modules", "@anthropic-ai", "sandbox-runtime"),
    // User-local npm global
    join2(home, ".npm", "lib", "node_modules", "@anthropic-ai", "sandbox-runtime"),
    join2(home, ".npm-global", "lib", "node_modules", "@anthropic-ai", "sandbox-runtime")
  );
  cachedGlobalNpmPaths = paths;
  return paths;
}
function getVendorArchitecture() {
  const arch = process.arch;
  switch (arch) {
    case "x64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "ia32":
    case "x86":
      logForDebugging(`[SeccompFilter] 32-bit x86 (ia32) is not currently supported due to missing socketcall() syscall blocking. The current seccomp filter only blocks socket(AF_UNIX, ...), but on 32-bit x86, socketcall() can be used to bypass this.`, { level: "error" });
      return null;
    default:
      logForDebugging(`[SeccompFilter] Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
      return null;
  }
}
function getLocalSeccompPaths(filename) {
  const arch = getVendorArchitecture();
  if (!arch)
    return [];
  const baseDir = dirname2(fileURLToPath(import.meta.url));
  const relativePath = join2("vendor", "seccomp", arch, filename);
  return [
    join2(baseDir, relativePath),
    // bundled: same directory as bundle (e.g., when bundled into claude-cli)
    join2(baseDir, "..", "..", relativePath),
    // package root: vendor/seccomp/...
    join2(baseDir, "..", relativePath)
    // dist: dist/vendor/seccomp/...
  ];
}
function getApplySeccompBinaryPath(seccompBinaryPath) {
  const cacheKey = seccompBinaryPath ?? "";
  if (applySeccompPathCache.has(cacheKey)) {
    return applySeccompPathCache.get(cacheKey);
  }
  const result = findApplySeccompPath(seccompBinaryPath);
  applySeccompPathCache.set(cacheKey, result);
  return result;
}
function findApplySeccompPath(seccompBinaryPath) {
  if (seccompBinaryPath) {
    if (fs2.existsSync(seccompBinaryPath)) {
      logForDebugging(`[SeccompFilter] Using apply-seccomp binary from explicit path: ${seccompBinaryPath}`);
      return seccompBinaryPath;
    }
    logForDebugging(`[SeccompFilter] Explicit path provided but file not found: ${seccompBinaryPath}`);
  }
  const arch = getVendorArchitecture();
  if (!arch) {
    logForDebugging(`[SeccompFilter] Cannot find apply-seccomp binary: unsupported architecture ${process.arch}`);
    return null;
  }
  logForDebugging(`[SeccompFilter] Looking for apply-seccomp binary for architecture: ${arch}`);
  for (const binaryPath of getLocalSeccompPaths("apply-seccomp")) {
    if (fs2.existsSync(binaryPath)) {
      logForDebugging(`[SeccompFilter] Found apply-seccomp binary: ${binaryPath} (${arch})`);
      return binaryPath;
    }
  }
  for (const globalBase of getGlobalNpmPaths()) {
    const binaryPath = join2(globalBase, "vendor", "seccomp", arch, "apply-seccomp");
    if (fs2.existsSync(binaryPath)) {
      logForDebugging(`[SeccompFilter] Found apply-seccomp binary in global install: ${binaryPath} (${arch})`);
      return binaryPath;
    }
  }
  logForDebugging(`[SeccompFilter] apply-seccomp binary not found in any expected location (${arch})`);
  return null;
}

// node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js
var DEFAULT_MANDATORY_DENY_SEARCH_DEPTH = 3;
function findSymlinkInPath(targetPath, allowedWritePaths) {
  const parts = targetPath.split(path2.sep);
  let currentPath = "";
  for (const part of parts) {
    if (!part)
      continue;
    const nextPath = currentPath + path2.sep + part;
    try {
      const stats = fs3.lstatSync(nextPath);
      if (stats.isSymbolicLink()) {
        const isWithinAllowedPath = allowedWritePaths.some((allowedPath) => nextPath.startsWith(allowedPath + "/") || nextPath === allowedPath);
        if (isWithinAllowedPath) {
          return nextPath;
        }
      }
    } catch {
      break;
    }
    currentPath = nextPath;
  }
  return null;
}
var MAX_SYMLINK_RESOLUTION_DEPTH = 40;
function resolveSymlinkedDenyPath(targetPath) {
  let current = targetPath;
  for (let i = 0; i < MAX_SYMLINK_RESOLUTION_DEPTH; i++) {
    try {
      return fs3.realpathSync(current);
    } catch {
    }
    let ancestor = current;
    const remainder = [];
    let resolvedAncestor = null;
    while (resolvedAncestor === null) {
      const parent = path2.dirname(ancestor);
      if (parent === ancestor) {
        return null;
      }
      remainder.unshift(path2.basename(ancestor));
      ancestor = parent;
      try {
        resolvedAncestor = fs3.realpathSync(ancestor);
      } catch {
      }
    }
    const firstMissing = path2.join(resolvedAncestor, remainder[0]);
    let linkTarget = null;
    try {
      linkTarget = fs3.readlinkSync(firstMissing);
    } catch {
    }
    if (linkTarget === null) {
      return path2.join(resolvedAncestor, ...remainder);
    }
    current = path2.join(path2.resolve(path2.dirname(firstMissing), linkTarget), ...remainder.slice(1));
  }
  return null;
}
function hasFileAncestor(targetPath) {
  const parts = targetPath.split(path2.sep);
  let currentPath = "";
  for (const part of parts) {
    if (!part)
      continue;
    const nextPath = currentPath + path2.sep + part;
    try {
      const stat = fs3.statSync(nextPath);
      if (stat.isFile() || stat.isSymbolicLink()) {
        return true;
      }
    } catch {
      break;
    }
    currentPath = nextPath;
  }
  return false;
}
function findFirstNonExistentComponent(targetPath) {
  const parts = targetPath.split(path2.sep);
  let currentPath = "";
  for (const part of parts) {
    if (!part)
      continue;
    const nextPath = currentPath + path2.sep + part;
    if (!fs3.existsSync(nextPath)) {
      return nextPath;
    }
    currentPath = nextPath;
  }
  return targetPath;
}
async function linuxGetMandatoryDenyPaths(ripgrepConfig = { command: "rg" }, maxDepth = DEFAULT_MANDATORY_DENY_SEARCH_DEPTH, allowGitConfig = false, abortSignal) {
  const cwd = process.cwd();
  const fallbackController = new AbortController();
  const signal = abortSignal ?? fallbackController.signal;
  const dangerousDirectories = getDangerousDirectories();
  const denyPaths = [
    // Dangerous files in CWD
    ...DANGEROUS_FILES.map((f) => path2.resolve(cwd, f)),
    // Dangerous directories in CWD
    ...dangerousDirectories.map((d) => path2.resolve(cwd, d))
  ];
  const dotGitPath = path2.resolve(cwd, ".git");
  let dotGitIsDirectory = false;
  try {
    dotGitIsDirectory = fs3.statSync(dotGitPath).isDirectory();
  } catch {
  }
  if (dotGitIsDirectory) {
    denyPaths.push(path2.resolve(cwd, ".git/hooks"));
    if (!allowGitConfig) {
      denyPaths.push(path2.resolve(cwd, ".git/config"));
    }
  }
  const iglobArgs = [];
  for (const fileName of DANGEROUS_FILES) {
    iglobArgs.push("--iglob", fileName);
  }
  for (const dirName of dangerousDirectories) {
    iglobArgs.push("--iglob", `**/${dirName}/**`);
  }
  iglobArgs.push("--iglob", "**/.git/hooks/**");
  if (!allowGitConfig) {
    iglobArgs.push("--iglob", "**/.git/config");
  }
  let matches = [];
  try {
    matches = await ripGrep([
      "--files",
      "--hidden",
      "--max-depth",
      String(maxDepth),
      ...iglobArgs,
      "-g",
      "!**/node_modules/**"
    ], cwd, signal, ripgrepConfig);
  } catch (error) {
    logForDebugging(`[Sandbox] ripgrep scan failed: ${error}`);
  }
  for (const match of matches) {
    const absolutePath = path2.resolve(cwd, match);
    let foundDir = false;
    for (const dirName of [...dangerousDirectories, ".git"]) {
      const normalizedDirName = normalizeCaseForComparison(dirName);
      const segments = absolutePath.split(path2.sep);
      const dirIndex = segments.findIndex((s) => normalizeCaseForComparison(s) === normalizedDirName);
      if (dirIndex !== -1) {
        if (dirName === ".git") {
          const gitDir = segments.slice(0, dirIndex + 1).join(path2.sep);
          if (match.includes(".git/hooks")) {
            denyPaths.push(path2.join(gitDir, "hooks"));
          } else if (match.includes(".git/config")) {
            denyPaths.push(path2.join(gitDir, "config"));
          }
        } else {
          denyPaths.push(segments.slice(0, dirIndex + 1).join(path2.sep));
        }
        foundDir = true;
        break;
      }
    }
    if (!foundDir) {
      denyPaths.push(absolutePath);
    }
  }
  return [...new Set(denyPaths)];
}
var bwrapMountPoints = /* @__PURE__ */ new Set();
var activeSandboxCount = 0;
var exitHandlerRegistered = false;
function registerExitCleanupHandler() {
  if (exitHandlerRegistered) {
    return;
  }
  process.on("exit", () => {
    cleanupBwrapMountPoints({ force: true });
  });
  exitHandlerRegistered = true;
}
function cleanupBwrapMountPoints(opts) {
  if (!opts?.force) {
    if (activeSandboxCount > 0) {
      activeSandboxCount--;
    }
    if (activeSandboxCount > 0) {
      logForDebugging(`[Sandbox Linux] Deferring mount point cleanup \u2014 ${activeSandboxCount} sandbox(es) still active`);
      return;
    }
  } else {
    activeSandboxCount = 0;
  }
  for (const mountPoint of bwrapMountPoints) {
    try {
      const stat = fs3.statSync(mountPoint);
      if (stat.isFile() && stat.size === 0) {
        fs3.unlinkSync(mountPoint);
        logForDebugging(`[Sandbox Linux] Cleaned up bwrap mount point (file): ${mountPoint}`);
      } else if (stat.isDirectory()) {
        const entries = fs3.readdirSync(mountPoint);
        if (entries.length === 0) {
          fs3.rmdirSync(mountPoint);
          logForDebugging(`[Sandbox Linux] Cleaned up bwrap mount point (dir): ${mountPoint}`);
        }
      }
    } catch {
    }
  }
  bwrapMountPoints.clear();
}
function isExecutable(p) {
  try {
    fs3.accessSync(p, fs3.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function checkLinuxDependencies(opts) {
  const { seccompConfig, bwrapPath, socatPath } = opts ?? {};
  const errors = [];
  const warnings = [];
  if (bwrapPath) {
    if (!isExecutable(bwrapPath))
      errors.push(`bubblewrap (bwrap) not executable at ${bwrapPath}`);
  } else if (whichSync("bwrap") === null) {
    errors.push("bubblewrap (bwrap) not installed");
  }
  if (socatPath) {
    if (!isExecutable(socatPath))
      errors.push(`socat not executable at ${socatPath}`);
  } else if (whichSync("socat") === null) {
    errors.push("socat not installed");
  }
  if (!seccompConfig?.argv0 && getApplySeccompBinaryPath(seccompConfig?.applyPath) === null) {
    warnings.push("seccomp not available - unix socket access not restricted");
  }
  return { warnings, errors };
}
function resolveApplySeccompPrefix(applyPath, argv0) {
  if (argv0) {
    if (!applyPath) {
      throw new Error("seccompConfig.argv0 requires seccompConfig.applyPath");
    }
    return `ARGV0=${quote([argv0])} ${quote([applyPath])} `;
  }
  const binary = getApplySeccompBinaryPath(applyPath);
  return binary ? `${quote([binary])} ` : void 0;
}
function buildSandboxCommand(httpSocketPath, socksSocketPath, userCommand, applySeccompPrefix, shell, socatPath) {
  const shellPath = shell || "bash";
  const socat = quote([socatPath ?? "socat"]);
  const socatCommands = [
    `${socat} TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:${httpSocketPath} >/dev/null 2>&1 &`,
    `${socat} TCP-LISTEN:1080,fork,reuseaddr UNIX-CONNECT:${socksSocketPath} >/dev/null 2>&1 &`,
    'trap "kill %1 %2 2>/dev/null; exit" EXIT'
  ];
  if (applySeccompPrefix) {
    const applySeccompCmd = applySeccompPrefix + quote([shellPath, "-c", userCommand]);
    const innerScript = [...socatCommands, applySeccompCmd].join("\n");
    return `${shellPath} -c ${quote([innerScript])}`;
  } else {
    const innerScript = [...socatCommands, `eval ${quote([userCommand])}`].join("\n");
    return `${shellPath} -c ${quote([innerScript])}`;
  }
}
function resolveSymlinkDenyDest(normalizedPath) {
  try {
    if (fs3.lstatSync(normalizedPath).isSymbolicLink()) {
      return fs3.realpathSync(normalizedPath);
    }
  } catch {
  }
  return normalizedPath;
}
function pushReadDenyDirMounts(args, normalizedPath, allowedWritePaths, readAllowPaths) {
  const denySep = normalizedPath === "/" ? "/" : normalizedPath + "/";
  args.push("--tmpfs", normalizedPath);
  for (const writePath of allowedWritePaths) {
    if (writePath.startsWith(denySep) || writePath === normalizedPath) {
      args.push("--bind", writePath, writePath);
      logForDebugging(`[Sandbox Linux] Re-bound write path wiped by denyRead tmpfs: ${writePath}`);
    }
  }
  for (const allowPath of readAllowPaths) {
    if (allowPath.startsWith(denySep) || allowPath === normalizedPath) {
      if (!fs3.existsSync(allowPath)) {
        logForDebugging(`[Sandbox Linux] Skipping non-existent read allow path: ${allowPath}`);
        continue;
      }
      if (allowedWritePaths.some((w) => (w.startsWith(denySep) || w === normalizedPath) && (allowPath === w || allowPath.startsWith(w + "/")))) {
        continue;
      }
      args.push("--ro-bind", allowPath, allowPath);
      logForDebugging(`[Sandbox Linux] Re-allowed read access within denied region: ${allowPath}`);
    }
  }
}
async function generateFilesystemArgs(readConfig, writeConfig, maskedFileBinds, maskedFileStoreDir, ripgrepConfig = { command: "rg" }, mandatoryDenySearchDepth = DEFAULT_MANDATORY_DENY_SEARCH_DEPTH, allowGitConfig = false, abortSignal) {
  const args = [];
  const allowedWritePaths = [];
  const denyWriteArgs = [];
  const readOnlyDenyDirSpellings = /* @__PURE__ */ new Map();
  const denyWriteRawDests = /* @__PURE__ */ new Map();
  if (writeConfig) {
    args.push("--ro-bind", "/", "/");
    for (const pathPattern of writeConfig.allowOnly || []) {
      const normalizedPath = normalizePathForSandbox(pathPattern).replace(/\/+$/, "") || "/";
      logForDebugging(`[Sandbox Linux] Processing write path: ${pathPattern} -> ${normalizedPath}`);
      if (normalizedPath.startsWith("/dev/")) {
        logForDebugging(`[Sandbox Linux] Skipping /dev path: ${normalizedPath}`);
        continue;
      }
      if (!fs3.existsSync(normalizedPath)) {
        logForDebugging(`[Sandbox Linux] Skipping non-existent write path: ${normalizedPath}`);
        continue;
      }
      try {
        const resolvedPath = fs3.realpathSync(normalizedPath);
        const normalizedForComparison = normalizedPath.replace(/\/+$/, "");
        if (resolvedPath !== normalizedForComparison && isSymlinkOutsideBoundary(normalizedPath, resolvedPath)) {
          logForDebugging(`[Sandbox Linux] Skipping symlink write path pointing outside expected location: ${pathPattern} -> ${resolvedPath}`);
          continue;
        }
      } catch {
        logForDebugging(`[Sandbox Linux] Skipping write path that could not be resolved: ${normalizedPath}`);
        continue;
      }
      args.push("--bind", normalizedPath, normalizedPath);
      allowedWritePaths.push(normalizedPath);
    }
    let stubSkipVetoInputs;
    const getStubSkipVetoInputs = () => {
      if (stubSkipVetoInputs !== void 0) {
        return stubSkipVetoInputs;
      }
      const allowedWritePathsBothForms = [];
      for (const writePath of allowedWritePaths) {
        allowedWritePathsBothForms.push(writePath);
        try {
          const canonical = fs3.realpathSync(writePath);
          if (canonical !== writePath) {
            allowedWritePathsBothForms.push(canonical);
          }
        } catch {
        }
      }
      const prospectiveReadDenyTmpfsDirsBothForms = [];
      if (readConfig) {
        const effectiveReadDenyPaths = [];
        const rootSkipForGuard = /* @__PURE__ */ new Set(["proc", "dev", "sys"]);
        for (const denyReadPattern of readConfig.denyOnly || []) {
          if (normalizePathForSandbox(denyReadPattern) === "/") {
            try {
              for (const child of fs3.readdirSync("/")) {
                if (!rootSkipForGuard.has(child))
                  effectiveReadDenyPaths.push("/" + child);
              }
            } catch {
            }
          } else {
            effectiveReadDenyPaths.push(denyReadPattern);
          }
        }
        if (fs3.existsSync("/etc/ssh/ssh_config.d")) {
          effectiveReadDenyPaths.push("/etc/ssh/ssh_config.d");
        }
        for (const effectiveReadDenyPath of effectiveReadDenyPaths) {
          const denyReadPath = normalizePathForSandbox(effectiveReadDenyPath);
          let isDirectory = false;
          try {
            isDirectory = fs3.statSync(denyReadPath).isDirectory();
          } catch {
            continue;
          }
          if (!isDirectory) {
            continue;
          }
          prospectiveReadDenyTmpfsDirsBothForms.push(denyReadPath);
          try {
            const canonical = fs3.realpathSync(denyReadPath);
            if (canonical !== denyReadPath) {
              prospectiveReadDenyTmpfsDirsBothForms.push(canonical);
            }
          } catch {
          }
        }
      }
      stubSkipVetoInputs = {
        allowedWritePathsBothForms,
        prospectiveReadDenyTmpfsDirsBothForms
      };
      return stubSkipVetoInputs;
    };
    const isWithinAnyAllowedWritePath = (candidatePath) => allowedWritePaths.some((allowedPath) => candidatePath.startsWith(allowedPath + "/") || candidatePath === allowedPath);
    const denyPaths = [
      ...writeConfig.denyWithinAllow || [],
      ...await linuxGetMandatoryDenyPaths(ripgrepConfig, mandatoryDenySearchDepth, allowGitConfig, abortSignal)
    ];
    const seenDenyWrite = /* @__PURE__ */ new Set();
    for (const pathPattern of denyPaths) {
      const rawPath = normalizePathForSandbox(pathPattern);
      if (rawPath.startsWith("/dev/")) {
        continue;
      }
      const resolvedPath = resolveSymlinkedDenyPath(rawPath);
      if (resolvedPath === null || resolvedPath.startsWith("/dev/")) {
        continue;
      }
      if (findSymlinkInPath(resolvedPath, allowedWritePaths)) {
        continue;
      }
      let isDirectory = false;
      try {
        isDirectory = fs3.statSync(resolvedPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) {
        continue;
      }
      if (isWithinAnyAllowedWritePath(resolvedPath)) {
        let spellings = readOnlyDenyDirSpellings.get(resolvedPath);
        if (spellings === void 0) {
          spellings = /* @__PURE__ */ new Set();
          readOnlyDenyDirSpellings.set(resolvedPath, spellings);
        }
        spellings.add(rawPath);
      }
    }
    const coveringDirUnsafeVerdicts = /* @__PURE__ */ new Map();
    const coveringDirIsUnsafe = (denyDir) => {
      const cached = coveringDirUnsafeVerdicts.get(denyDir);
      if (cached !== void 0) {
        return cached;
      }
      const { allowedWritePathsBothForms, prospectiveReadDenyTmpfsDirsBothForms } = getStubSkipVetoInputs();
      const unsafe = (
        // (i) an allowed write path strictly beneath the dir: the
        //     re-application's effect would re-bind it writable.
        allowedWritePathsBothForms.some((writePath) => writePath.startsWith(denyDir + "/")) || // (ii) a read-deny tmpfs at or beneath the dir: the re-application's
        //     trigger.
        prospectiveReadDenyTmpfsDirsBothForms.some((tmpfsDir) => tmpfsDir === denyDir || tmpfsDir.startsWith(denyDir + "/")) || // (iii) a read-deny tmpfs CONTAINING the dir or any raw spelling it
        //     was reached through: the dir's own --ro-bind can be dropped as
        //     hidden-by-the-tmpfs at emission, and a tmpfs above it can
        //     re-bind an allowed path around it — either way the directory
        //     is not reliably read-only in the sandbox.
        prospectiveReadDenyTmpfsDirsBothForms.some((tmpfsDir) => [denyDir, ...readOnlyDenyDirSpellings.get(denyDir) ?? []].some((spelling) => spelling === tmpfsDir || spelling.startsWith(tmpfsDir + "/")))
      );
      coveringDirUnsafeVerdicts.set(denyDir, unsafe);
      return unsafe;
    };
    const readOnlyDenyDirs = [...readOnlyDenyDirSpellings.keys()];
    for (const pathPattern of denyPaths) {
      const rawPath = normalizePathForSandbox(pathPattern);
      if (rawPath.startsWith("/dev/")) {
        continue;
      }
      const normalizedPath = resolveSymlinkedDenyPath(rawPath);
      if (normalizedPath === null) {
        const unresolvableSymlink = findSymlinkInPath(rawPath, allowedWritePaths);
        if (unresolvableSymlink && !seenDenyWrite.has(unresolvableSymlink)) {
          seenDenyWrite.add(unresolvableSymlink);
          denyWriteArgs.push("--ro-bind", "/dev/null", unresolvableSymlink);
          denyWriteRawDests.set(unresolvableSymlink, rawPath);
        }
        logForDebugging(`[Sandbox Linux] Deny path could not be resolved through symlinks, failing closed: ${rawPath}`);
        continue;
      }
      if (normalizedPath !== rawPath) {
        logForDebugging(`[Sandbox Linux] Resolved symlinked deny path: ${rawPath} -> ${normalizedPath}`);
      }
      if (normalizedPath.startsWith("/dev/")) {
        continue;
      }
      if (seenDenyWrite.has(normalizedPath))
        continue;
      seenDenyWrite.add(normalizedPath);
      const symlinkInPath = findSymlinkInPath(normalizedPath, allowedWritePaths);
      if (symlinkInPath) {
        if (!seenDenyWrite.has(symlinkInPath)) {
          seenDenyWrite.add(symlinkInPath);
          denyWriteArgs.push("--ro-bind", "/dev/null", symlinkInPath);
          denyWriteRawDests.set(symlinkInPath, rawPath);
        }
        logForDebugging(`[Sandbox Linux] Mounted /dev/null at symlink ${symlinkInPath} to prevent symlink replacement attack`);
        continue;
      }
      if (!fs3.existsSync(normalizedPath)) {
        if (hasFileAncestor(normalizedPath)) {
          logForDebugging(`[Sandbox Linux] Skipping deny path with file ancestor (cannot create paths under a file): ${normalizedPath}`);
          continue;
        }
        let ancestorPath = path2.dirname(normalizedPath);
        while (ancestorPath !== "/" && !fs3.existsSync(ancestorPath)) {
          ancestorPath = path2.dirname(ancestorPath);
        }
        const ancestorIsWithinAllowedPath = isWithinAnyAllowedWritePath(ancestorPath) || isWithinAnyAllowedWritePath(normalizedPath);
        const coveringReadOnlyDenyDirs = readOnlyDenyDirs.filter((denyDir) => ancestorPath === denyDir || ancestorPath.startsWith(denyDir + "/"));
        const ancestorIsWithinReadOnlyDeny = coveringReadOnlyDenyDirs.length > 0 && !coveringReadOnlyDenyDirs.some(coveringDirIsUnsafe);
        if (ancestorIsWithinAllowedPath && !ancestorIsWithinReadOnlyDeny) {
          const firstNonExistent = findFirstNonExistentComponent(normalizedPath);
          if (firstNonExistent !== normalizedPath) {
            const emptyDir = fs3.mkdtempSync(path2.join(tmpdir(), "claude-empty-"));
            denyWriteArgs.push("--ro-bind", emptyDir, firstNonExistent);
            denyWriteRawDests.set(firstNonExistent, rawPath);
            bwrapMountPoints.add(firstNonExistent);
            registerExitCleanupHandler();
            logForDebugging(`[Sandbox Linux] Mounted empty dir at ${firstNonExistent} to block creation of ${normalizedPath}`);
          } else {
            denyWriteArgs.push("--ro-bind", "/dev/null", firstNonExistent);
            denyWriteRawDests.set(firstNonExistent, rawPath);
            bwrapMountPoints.add(firstNonExistent);
            registerExitCleanupHandler();
            logForDebugging(`[Sandbox Linux] Mounted /dev/null at ${firstNonExistent} to block creation of ${normalizedPath}`);
          }
        } else if (ancestorIsWithinReadOnlyDeny) {
          logForDebugging(`[Sandbox Linux] Skipping non-existent deny path inside a read-only denied directory (already uncreatable): ${normalizedPath}`);
        } else {
          logForDebugging(`[Sandbox Linux] Skipping non-existent deny path not within allowed paths: ${normalizedPath}`);
        }
        continue;
      }
      const isWithinAllowedPath = isWithinAnyAllowedWritePath(normalizedPath);
      if (isWithinAllowedPath) {
        denyWriteArgs.push("--ro-bind", normalizedPath, normalizedPath);
        denyWriteRawDests.set(normalizedPath, rawPath);
      } else {
        logForDebugging(`[Sandbox Linux] Skipping deny path not within allowed paths: ${normalizedPath}`);
      }
    }
  } else {
    args.push("--bind", "/", "/");
  }
  const readDenyPaths = [];
  const readAllowPaths = (readConfig?.allowWithinDeny || []).map((p) => normalizePathForSandbox(p));
  const maskedFiles = /* @__PURE__ */ new Map();
  const tmpfsDirs = [];
  const rootSkip = /* @__PURE__ */ new Set(["proc", "dev", "sys"]);
  for (const p of readConfig?.denyOnly || []) {
    if (normalizePathForSandbox(p) === "/") {
      for (const child of fs3.readdirSync("/")) {
        if (!rootSkip.has(child))
          readDenyPaths.push("/" + child);
      }
    } else {
      readDenyPaths.push(p);
    }
  }
  if (readConfig && fs3.existsSync("/etc/ssh/ssh_config.d")) {
    readDenyPaths.push("/etc/ssh/ssh_config.d");
  }
  const normalizedDenyPaths = readDenyPaths.map((p) => normalizePathForSandbox(p)).sort((a, b) => a.split("/").length - b.split("/").length);
  for (const normalizedPath of normalizedDenyPaths) {
    if (!fs3.existsSync(normalizedPath)) {
      logForDebugging(`[Sandbox Linux] Skipping non-existent read deny path: ${normalizedPath}`);
      continue;
    }
    const readDenyStat = fs3.statSync(normalizedPath);
    if (readDenyStat.isDirectory()) {
      tmpfsDirs.push(normalizedPath);
      pushReadDenyDirMounts(args, normalizedPath, allowedWritePaths, readAllowPaths);
    } else {
      if (readAllowPaths.includes(normalizedPath)) {
        logForDebugging(`[Sandbox Linux] Skipping read deny for re-allowed path: ${normalizedPath}`);
        continue;
      }
      const denyDest = resolveSymlinkDenyDest(normalizedPath);
      args.push("--ro-bind", "/dev/null", denyDest);
      maskedFiles.set(denyDest, "/dev/null");
      maskedFiles.set(normalizedPath, "/dev/null");
    }
  }
  for (const { realPath, fakePath } of maskedFileBinds ?? []) {
    const dest = resolveSymlinkDenyDest(realPath);
    args.push("--ro-bind", fakePath, dest);
    maskedFiles.set(dest, fakePath);
    maskedFiles.set(realPath, fakePath);
  }
  const isHiddenByTmpfs = (dest) => tmpfsDirs.some((tmpfsDir) => {
    const underTmpfs = dest === tmpfsDir || dest.startsWith(tmpfsDir + "/");
    if (!underTmpfs)
      return false;
    const reExposedByWriteBind = allowedWritePaths.some((writePath) => (writePath === tmpfsDir || writePath.startsWith(tmpfsDir + "/")) && (dest === writePath || dest.startsWith(writePath + "/")));
    return !reExposedByWriteBind;
  });
  const emittedDenyWriteDests = [];
  for (let i = 0; i < denyWriteArgs.length; i += 3) {
    const dest = denyWriteArgs[i + 2];
    const rawDest = denyWriteRawDests.get(dest) ?? dest;
    if (maskedFiles.has(dest))
      continue;
    if (isHiddenByTmpfs(dest) || isHiddenByTmpfs(rawDest)) {
      logForDebugging(`[Sandbox Linux] Skipping denyWrite bind already hidden by denyRead tmpfs: ${dest}`);
      continue;
    }
    args.push(denyWriteArgs[i], denyWriteArgs[i + 1], dest);
    emittedDenyWriteDests.push(dest);
    if (rawDest !== dest)
      emittedDenyWriteDests.push(rawDest);
  }
  for (const tmpfsDir of tmpfsDirs) {
    if (emittedDenyWriteDests.some((dest) => tmpfsDir.startsWith(dest + "/"))) {
      logForDebugging(`[Sandbox Linux] Re-applying denyRead tmpfs re-exposed by denyWrite bind: ${tmpfsDir}`);
      pushReadDenyDirMounts(args, tmpfsDir, allowedWritePaths, readAllowPaths);
    }
  }
  for (const [maskedFile, source] of maskedFiles) {
    if (emittedDenyWriteDests.some((dest) => maskedFile.startsWith(dest + "/"))) {
      if (resolveSymlinkDenyDest(maskedFile) !== maskedFile)
        continue;
      logForDebugging(`[Sandbox Linux] Re-applying file mask re-exposed by denyWrite bind: ${maskedFile}`);
      args.push("--ro-bind", source, maskedFile);
    }
  }
  if (maskedFileStoreDir !== void 0) {
    args.push("--ro-bind", maskedFileStoreDir, maskedFileStoreDir);
  }
  return args;
}
async function wrapCommandWithSandboxLinux(params) {
  const { command, commandId, needsNetworkRestriction, httpSocketPath, socksSocketPath, httpProxyPort, socksProxyPort, proxyAuthToken, caCertPath, readConfig, writeConfig, unsetEnvVars, setEnvVars, maskedFileBinds, maskedFileStoreDir, enableWeakerNestedSandbox, allowAllUnixSockets, binShell, ripgrepConfig = { command: "rg" }, mandatoryDenySearchDepth = DEFAULT_MANDATORY_DENY_SEARCH_DEPTH, allowGitConfig = false, gitSafeDirectories, seccompConfig, bwrapPath, socatPath, observeSocketPath, abortSignal } = params;
  const hasReadRestrictions = readConfig && readConfig.denyOnly.length > 0 || maskedFileBinds !== void 0 && maskedFileBinds.length > 0;
  const hasWriteRestrictions = writeConfig !== void 0;
  const hasEnvRestrictions = unsetEnvVars !== void 0 && unsetEnvVars.length > 0 || setEnvVars !== void 0 && Object.keys(setEnvVars).length > 0;
  const hasGitConfig = (gitSafeDirectories?.length ?? 0) > 0;
  if (!needsNetworkRestriction && !hasReadRestrictions && !hasWriteRestrictions && !hasEnvRestrictions && !hasGitConfig) {
    return command;
  }
  activeSandboxCount++;
  const bwrapArgs = ["--new-session", "--die-with-parent"];
  let applySeccompPrefix;
  try {
    if (!allowAllUnixSockets) {
      applySeccompPrefix = resolveApplySeccompPrefix(seccompConfig?.applyPath, seccompConfig?.argv0);
      if (!applySeccompPrefix) {
        logForDebugging("[Sandbox Linux] apply-seccomp binary not available - unix socket blocking disabled. Install @anthropic-ai/sandbox-runtime globally for full protection.", { level: "warn" });
      } else {
        logForDebugging("[Sandbox Linux] Applying seccomp filter for Unix socket blocking");
      }
    } else {
      logForDebugging("[Sandbox Linux] Skipping seccomp filter - allowAllUnixSockets is enabled");
    }
    if (observeSocketPath && applySeccompPrefix) {
      if (fs3.existsSync(observeSocketPath)) {
        bwrapArgs.push("--bind", observeSocketPath, observeSocketPath);
        bwrapArgs.push("--setenv", "SRT_OBSERVE_SOCK", observeSocketPath);
        bwrapArgs.push("--setenv", "SRT_ENCODED_CMD", encodeSandboxedCommand(commandId ?? command));
      } else {
        logForDebugging("[Sandbox Linux] observe socket missing \u2014 supervisor not running; continuing without violation monitoring");
      }
    }
    if (hasEnvRestrictions) {
      for (const name of unsetEnvVars ?? []) {
        bwrapArgs.push("--unsetenv", name);
      }
      for (const [name, value] of Object.entries(setEnvVars ?? {})) {
        bwrapArgs.push("--setenv", name, value);
      }
    }
    if (gitSafeDirectories && gitSafeDirectories.length > 0) {
      const gitCfg = buildPosixGitSafeDirEnv({
        safeDirs: gitSafeDirectories,
        unsetEnvVars,
        setEnvVars
      });
      for (const [name, value] of Object.entries(gitCfg)) {
        bwrapArgs.push("--setenv", name, value);
      }
    }
    if (needsNetworkRestriction) {
      bwrapArgs.push("--unshare-net");
      if (httpSocketPath && socksSocketPath) {
        if (!fs3.existsSync(httpSocketPath)) {
          throw new Error(`Linux HTTP bridge socket does not exist: ${httpSocketPath}. The bridge process may have died. Try reinitializing the sandbox.`);
        }
        if (!fs3.existsSync(socksSocketPath)) {
          throw new Error(`Linux SOCKS bridge socket does not exist: ${socksSocketPath}. The bridge process may have died. Try reinitializing the sandbox.`);
        }
        bwrapArgs.push("--bind", httpSocketPath, httpSocketPath);
        if (socksSocketPath !== httpSocketPath) {
          bwrapArgs.push("--bind", socksSocketPath, socksSocketPath);
        }
        const proxyEnv = generateProxyEnvVars(
          3128,
          // Internal HTTP listener port
          1080,
          // Internal SOCKS listener port
          caCertPath,
          proxyAuthToken,
          writeConfig === void 0,
          encodeSandboxedCommand(commandId ?? command)
        );
        bwrapArgs.push(...proxyEnv.flatMap((env) => {
          const firstEq = env.indexOf("=");
          const key = env.slice(0, firstEq);
          const value = env.slice(firstEq + 1);
          return ["--setenv", key, value];
        }));
        if (httpProxyPort !== void 0) {
          bwrapArgs.push("--setenv", "CLAUDE_CODE_HOST_HTTP_PROXY_PORT", String(httpProxyPort));
        }
        if (socksProxyPort !== void 0) {
          bwrapArgs.push("--setenv", "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT", String(socksProxyPort));
        }
      }
    }
    const fsArgs = await generateFilesystemArgs(readConfig, writeConfig, maskedFileBinds, maskedFileStoreDir, ripgrepConfig, mandatoryDenySearchDepth, allowGitConfig, abortSignal);
    bwrapArgs.push(...fsArgs);
    bwrapArgs.push("--dev", "/dev");
    bwrapArgs.push("--unshare-pid");
    if (!enableWeakerNestedSandbox) {
      bwrapArgs.push("--unshare-user", "--cap-drop", "ALL", "--proc", "/proc");
    } else {
      bwrapArgs.push("--unshare-user", "--bind", "/proc", "/proc");
    }
    const shellName = binShell || "bash";
    const shell = whichSync(shellName);
    if (!shell) {
      throw new Error(`Shell '${shellName}' not found in PATH`);
    }
    bwrapArgs.push("--", shell, "-c");
    if (needsNetworkRestriction && httpSocketPath && socksSocketPath) {
      const sandboxCommand = buildSandboxCommand(httpSocketPath, socksSocketPath, command, applySeccompPrefix, shell, socatPath);
      bwrapArgs.push(sandboxCommand);
    } else if (applySeccompPrefix) {
      const applySeccompCmd = applySeccompPrefix + quote([shell, "-c", command]);
      bwrapArgs.push(applySeccompCmd);
    } else {
      bwrapArgs.push(command);
    }
    const wrappedCommand = quote([bwrapPath ?? "bwrap", ...bwrapArgs]);
    const restrictions = [];
    if (needsNetworkRestriction)
      restrictions.push("network");
    if (hasReadRestrictions || hasWriteRestrictions)
      restrictions.push("filesystem");
    if (hasEnvRestrictions)
      restrictions.push("env");
    if (applySeccompPrefix)
      restrictions.push("seccomp(unix-block)");
    logForDebugging(`[Sandbox Linux] Wrapped command with bwrap (${restrictions.join(", ")} restrictions)`);
    return wrappedCommand;
  } catch (error) {
    if (activeSandboxCount > 0) {
      activeSandboxCount--;
    }
    throw error;
  }
}
export {
  checkLinuxDependencies,
  cleanupBwrapMountPoints,
  getDefaultWritePaths,
  hasRipgrepSync,
  wrapCommandWithSandboxLinux
};
