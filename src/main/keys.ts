// Provider API keys, encrypted at rest via Electron's safeStorage (DPAPI on
// Windows) and stored in a JSON file under userData -- never in localStorage,
// never readable from the renderer. Only `setApiKey`/`hasApiKey` are exposed
// over IPC (see src/preload/index.ts); `getApiKey` is main-process-internal,
// used by src/main/providers/index.ts to fetch the Claude key.
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

function keysFilePath(): string {
  return path.join(app.getPath('userData'), 'provider-keys.json');
}

function readStore(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(keysFilePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  const dir = path.dirname(keysFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keysFilePath(), JSON.stringify(store), 'utf8');
}

export function setApiKey(provider: string, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this system — cannot save the API key.');
  }
  const store = readStore();
  if (!key) {
    delete store[provider];
  } else {
    store[provider] = safeStorage.encryptString(key).toString('base64');
  }
  writeStore(store);
}

export function hasApiKey(provider: string): boolean {
  return Boolean(readStore()[provider]);
}

export function getApiKey(provider: string): string | null {
  const encoded = readStore()[provider];
  if (!encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}
