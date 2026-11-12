/**
 * OpenList implementation of {@link FileSyncProvider} — the credential-based,
 * path-addressed backend for self-hosted OpenList (the community fork of
 * AList), alongside WebDAV / S3 / Google Drive / OneDrive / iCloud.
 *
 * Shape of the mapping:
 *
 *  - **Paths are already absolute.** OpenList exposes one virtual tree whose
 *    first level is the mount points, so a logical sync path maps 1:1 onto an
 *    API `path` (`/onedrive/Readest/books/<hash>/config.json`). No id
 *    resolution, no cache — one logical operation is one HTTP request. The
 *    consequence the UI must carry: `/` itself is a mount list and is NOT
 *    writable, so `rootPath` has to point INSIDE one storage.
 *  - **`head` is `fs/get`.** OpenList has no HEAD on the RPC API; `fs/get`
 *    returns size + mtime for a file and rejects an absent path, which is
 *    exactly the probe contract. Not-found detection also reads the message,
 *    because several drivers report a missing object as code 500.
 *  - **Reads go through the `/p` proxy.** The signed `/d` route 302s to the
 *    underlying driver, which 403s on storages that require a Referer; `/p`
 *    streams the bytes from the OpenList server instead.
 *  - **Directories are real**, so `ensureDir` actually creates them (idempotent
 *    via an existence probe) and `deleteDir` empties bottom-up before removing
 *    the node itself — `fs/remove` refuses a non-empty directory.
 *
 * Streaming upload/download attach on Tauri only, using the native transfer
 * plugin; on web the engine falls back to buffered {@link writeBinary}. They
 * own the boolean swallow-to-`false` contract, matching the other providers.
 */

import { stat } from '@tauri-apps/plugin-fs';
import { isTauriAppPlatform } from '@/services/environment';
import { tauriDownload, tauriUpload } from '@/utils/transfer';
import type { ProgressHandler } from '@/utils/transfer';
import {
  FileEntry,
  FileHead,
  FileSyncError,
  FileSyncProvider,
} from '@/services/sync/file/provider';
import {
  baseNameOf,
  joinPath,
  normalizeOpenListRoot,
  OpenListClient,
  OpenListEntry,
  OpenListFetchFn,
  parentOf,
} from './openListClient';

/** Connection slice the provider needs (a subset of `OpenListSettings`). */
export interface OpenListProviderConfig {
  /** Server origin, e.g. `https://openlist.example.com`. */
  serverUrl: string;
  username: string;
  password: string;
  /** Directory INSIDE a storage, e.g. `/onedrive/Readest`. `/` is not writable. */
  rootPath: string;
}

const DEFAULT_TEXT_CONTENT_TYPE = 'application/json';
const DEFAULT_BINARY_CONTENT_TYPE = 'application/octet-stream';

const textDecoder = new TextDecoder();

class OpenListProviderImpl {
  readonly rootPath: string;

  constructor(
    config: OpenListProviderConfig,
    private readonly client: OpenListClient,
  ) {
    this.rootPath = normalizeOpenListRoot(config.rootPath);
  }

  /**
   * `fs/get` → entry, or `null` when the path does not exist. Used by both
   * {@link head} and the read paths, so a missing book file costs one request.
   */
  private async getEntry(path: string): Promise<OpenListEntry | null> {
    try {
      const entry = await this.client.call<OpenListEntry>('fs/get', { path, password: '' });
      return entry ?? null;
    } catch (e) {
      if (e instanceof FileSyncError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
  }

  async head(path: string): Promise<FileHead | null> {
    const entry = await this.getEntry(path);
    if (!entry) return null;
    return { size: entry.size };
  }

  async readText(path: string): Promise<string | null> {
    const buffer = await this.readBinary(path);
    return buffer ? textDecoder.decode(buffer) : null;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const entry = await this.getEntry(path);
    if (!entry || entry.is_dir) return null;
    const res = await this.client.download(path, entry.sign, entry.url ?? entry.durl);
    return res ? res.arrayBuffer() : null;
  }

  async list(path: string): Promise<FileEntry[]> {
    // Real servers wrap the array: `data: { content: [...], total, write, ... }`.
    // Older code paths (and some AList forks) have been seen returning the bare
    // array, so both shapes are accepted — assuming either one alone turns an
    // ordinary listing into "e.map is not a function".
    const data = await this.client.call<
      { content?: OpenListEntry[] | null } | OpenListEntry[] | null
    >('fs/list', {
      path,
      password: '',
      page: 1,
      // 0 = every child in one page; the sync subtree is small by design.
      per_page: 0,
      refresh: false,
    });
    const content = Array.isArray(data) ? data : data?.content;
    // An empty directory comes back as `content: null`, not `[]`.
    if (!Array.isArray(content)) return [];
    return content.map((entry) => ({
      name: entry.name,
      path: joinPath(path, entry.name),
      isDirectory: !!entry.is_dir,
      size: entry.size,
      lastModified: entry.modified,
    }));
  }

  writeText(
    path: string,
    body: string,
    contentType: string = DEFAULT_TEXT_CONTENT_TYPE,
  ): Promise<void> {
    return this.client.put(path, body, contentType);
  }

  writeBinary(
    path: string,
    body: ArrayBuffer,
    contentType: string = DEFAULT_BINARY_CONTENT_TYPE,
  ): Promise<void> {
    return this.client.put(path, body, contentType);
  }

  /**
   * Create each directory top-down. `fs/mkdir` reports an existing directory as
   * an error on most drivers, so a failure is verified with a `fs/get` probe
   * before it is allowed to surface — that is what makes this idempotent.
   */
  async ensureDir(paths: string[]): Promise<void> {
    for (const path of paths) {
      if (!path || path === '/') continue;
      try {
        await this.client.call('fs/mkdir', { path });
      } catch (e) {
        if (await this.isDirectory(path)) continue;
        throw e;
      }
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    const entry = await this.getEntry(path);
    return !!entry?.is_dir;
  }

  async deleteDir(path: string): Promise<void> {
    const emptied = await this.emptyTree(path);
    // Missing subtree is success, per the provider contract.
    if (!emptied) return;
    const parent = parentOf(path);
    const name = baseNameOf(path);
    if (!name) return;
    await this.removeEntries(parent, [name]);
  }

  /**
   * Depth-first emptying: every child directory is emptied (and removed) before
   * its parent is touched, because `fs/remove` rejects a non-empty directory.
   * Returns false when `path` itself does not exist.
   */
  private async emptyTree(path: string): Promise<boolean> {
    let entries: FileEntry[];
    try {
      entries = await this.list(path);
    } catch (e) {
      if (e instanceof FileSyncError && e.code === 'NOT_FOUND') return false;
      throw e;
    }
    for (const entry of entries) {
      if (entry.isDirectory) await this.emptyTree(entry.path);
    }
    if (entries.length > 0) {
      await this.removeEntries(
        path,
        entries.map((entry) => entry.name),
      );
    }
    return true;
  }

  private async removeEntries(dir: string, names: string[]): Promise<void> {
    if (names.length === 0) return;
    try {
      await this.client.call('fs/remove', { dir, names });
    } catch (e) {
      // Deleted concurrently — the caller's intent is satisfied.
      if (e instanceof FileSyncError && e.code === 'NOT_FOUND') return;
      throw e;
    }
  }

  /** Streaming upload from disk; `false` when the size is unknowable. */
  async uploadStream(remotePath: string, localPath: string): Promise<boolean> {
    try {
      const { size } = await stat(localPath);
      await this.client.putStream(
        remotePath,
        localPath,
        async (url, file, headers) => {
          await tauriUpload(url, file, 'PUT', undefined, headers);
        },
        size,
      );
      return true;
    } catch (e) {
      console.warn('OpenListProvider.uploadStream failed', remotePath, e);
      // A classified failure (bad credentials, missing path) must reach the
      // engine with its message intact; only unclassified transport noise is
      // reduced to the boolean "try the buffered path instead" contract.
      if (e instanceof FileSyncError) throw e;
      return false;
    }
  }

  async downloadStream(
    remotePath: string,
    localPath: string,
    onProgress?: ProgressHandler,
  ): Promise<boolean> {
    try {
      const entry = await this.getEntry(remotePath);
      if (!entry) return false;
      // Try each candidate in order (driver URL → logged-in /d → guest /p proxy);
      // the buffered `download()` shares this exact ordering. The `/d` candidate
      // needs the bearer token, the others do not.
      const targets = await this.client.resolveDownloadTargets(remotePath, entry.sign, entry.url ?? entry.durl);
      let lastErr: unknown;
      for (const target of targets) {
        try {
          const headers = target.auth
            ? new Map<string, string>([['Authorization', await this.client.ensureToken()]])
            : undefined;
          await tauriDownload(target.url, localPath, onProgress, headers);
          return true;
        } catch (e) {
          lastErr = e;
        }
      }
      console.warn('OpenListProvider.downloadStream failed', remotePath, lastErr);
      return false;
    } catch (e) {
      console.warn('OpenListProvider.downloadStream failed', remotePath, e);
      return false;
    }
  }
}

/**
 * Build an OpenList {@link FileSyncProvider}. Streaming methods attach on Tauri
 * only; they are deliberately NOT wrapped, so they keep their own
 * swallow-to-`false` contract like the WebDAV / S3 / Drive providers.
 */
export const createOpenListProvider = (
  config: OpenListProviderConfig,
  fetchFn?: OpenListFetchFn,
): FileSyncProvider => {
  const client = new OpenListClient(config, fetchFn);
  const impl = new OpenListProviderImpl(config, client);

  const provider: FileSyncProvider = {
    rootPath: impl.rootPath,
    readText: (path) => impl.readText(path),
    readBinary: (path) => impl.readBinary(path),
    head: (path) => impl.head(path),
    list: (path) => impl.list(path),
    writeText: (path, body, contentType) => impl.writeText(path, body, contentType),
    writeBinary: (path, body, contentType) => impl.writeBinary(path, body, contentType),
    ensureDir: (paths) => impl.ensureDir(paths),
    deleteDir: (path) => impl.deleteDir(path),
  };

  if (isTauriAppPlatform()) {
    provider.uploadStream = (remotePath, localPath) => impl.uploadStream(remotePath, localPath);
    provider.downloadStream = (remotePath, localPath, onProgress) =>
      impl.downloadStream(remotePath, localPath, onProgress);
  }

  return provider;
};

/**
 * Read-only reachability probe used by the settings form: logs in, then lists
 * the configured root. Proves credentials AND that the root is a real
 * directory inside a storage — the single most common OpenList setup mistake is
 * pointing at `/`, which exists as a mount list but cannot hold files.
 */
export const checkOpenListConnection = async (
  config: OpenListProviderConfig,
  fetchFn?: OpenListFetchFn,
): Promise<{ ok: boolean; entryCount: number }> => {
  const provider = createOpenListProvider(config, fetchFn);
  const entries = await provider.list(provider.rootPath);
  return { ok: true, entryCount: entries.length };
};
