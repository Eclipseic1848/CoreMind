export interface LinuxBackendParameters {
  command: string; commandId?: string; needsNetworkRestriction: true;
  readConfig: { denyOnly: string[]; allowWithinDeny: string[] };
  writeConfig: { allowOnly: string[]; denyWithinAllow: string[] };
  unsetEnvVars: string[]; enableWeakerNestedSandbox: false; allowAllUnixSockets: false;
  binShell: string; gitSafeDirectories: readonly string[];
  seccompConfig: { applyPath: string }; abortSignal?: AbortSignal;
}
export function wrapCommandWithSandboxLinux(params: LinuxBackendParameters): Promise<string>;
export function checkLinuxDependencies(options: { seccompConfig: { applyPath: string } }): { errors: string[]; warnings: string[] };
export function cleanupBwrapMountPoints(options?: { force?: boolean }): void;
export function getDefaultWritePaths(): string[];
export function hasRipgrepSync(): boolean;
