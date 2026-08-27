const registeredCoreMindRuntimes = new WeakSet<object>();

export function registerCoreMindRuntimeInstance(runtime: object): void {
  registeredCoreMindRuntimes.add(runtime);
}

export function isRegisteredCoreMindRuntimeInstance(runtime: object): boolean {
  return registeredCoreMindRuntimes.has(runtime);
}
