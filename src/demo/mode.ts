/** Demo routing is fixed for the document lifetime; leaving it requires a full navigation. */
export const demoMode = globalThis.location?.pathname.replace(/\/$/, "") === "/demo";
export const DEMO_STORAGE_KEY = "grimoire.demo.v1";
export const demoAssets = new Map<string, string>();
export const EMPTY_DEMO_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
let storageNotice = "";
export function demoStorageNotice(): string {
  return storageNotice;
}
export function setDemoStorageNotice(message: string): void {
  storageNotice = message;
  globalThis.dispatchEvent?.(new Event("grimoire-demo-storage"));
}
