/**
 * HTTP transport for OpenList (the community fork of AList) — the credential
 * half of the OpenList file-sync backend, mirroring `webdav/client.ts` and
 * `s3/S3Provider.ts` in shape.
 *
 * Shape of the API:
 *
 *  - **Everything is a POST under `/api/`**, except uploads (`PUT /api/fs/put`
 *    with a raw body) and downloads (`GET /p/<path>?sign=<sign>`, the server-side
 *    proxy route).
 *  - **Failures ride inside a 200.** OpenList answers `{ code, message, data }`
 *    and routinely returns HTTP 200 with `code: 401` / `code: 500`. Every
 *    response is therefore classified on `code` FIRST and on the HTTP status
 *    only as a fallback — a status-only check would read an expired token as a
 *    successful empty body and silently corrupt the library index.
 *  - **Auth is a bearer token** from `POST /api/auth/login`, valid ~48h. One
 *    single-flight login is shared by every concurrent call so a cold provider
 *    does not fire a burst of logins; a 401 clears the token and retries once.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { FileSyncError } from '@/services/sync/file/provider';

/** Injected `fetch`, typed to what the client uses (string URL + init). */
export type OpenListFetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenListClientConfig {
  /** Server origin, e.g. `https://openlist.example.com` or `http://192.168.1.9:5244`. */
  serverUrl: string;
  username: string;
  password: string;
}

/** One directory entry as returned by `/api/fs/list` and `/api/fs/get`. */
export interface OpenListEntry {
  name: string;
  /** Bytes; absent for directories on most drivers. */
  size?: number;
  is_dir?: boolean;
  modified?: string;
  created?: string;
  /** Short-lived download signature, required by the `/p` proxy route. */
  sign?: string;
}

interface OpenListEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

const API_PREFIX = '/api';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

/** OpenList's own success code — it is NOT the HTTP status. */
const CODE_OK = 200;

/** Treat a token as expired slightly early so a call never races the expiry. */
const TOKEN_TTL_MS = 47 * 60 * 60 * 1000;

/**
 * OpenList reports a missing object as `code: 500` ("object not found") on many
 * drivers and as `code: 404` on others, so not-found has to be read out of the
 * message too — otherwise every empty directory looks like a server fault.
 */
const NOT_FOUND_RE = /not\s*found|object not found|does not exist|no such file|不存在/i;

const trimTrailingSlash = (url: string): string => url.trim().replace(/\/+$/, '');

/** Percent-encode one path segment, keeping `/` separators literal. */
const encodeSegment = (segment: string): string => encodeURIComponent(segment);

/** Percent-encode a whole absolute path for a URL or the `File-Path` header. */
export const encodePath = (path: string): string => path.split('/').map(encodeSegment).join('/');

/** Join an absolute directory path and a child name into an absolute path. */
export const joinPath = (dir: string, name: string): string => {
  const base = dir.replace(/\/+$/, '');
  return `${base.startsWith('/') ? base : `/${base}`}/${name}`;
};

/** Absolute parent directory of a path (root's parent is root). */
export const parentOf = (path: string): string => {
  const segments = path.split('/').filter(Boolean);
  segments.pop();
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
};

/** Final segment of an absolute path. */
export const baseNameOf = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';

/** Normalise a user-entered root into `/a/b` form (root === '/'). */
export const normalizeOpenListRoot = (root: string | undefined): string => {
  if (!root) return '/';
  let p = root.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
};

/**
 * Map an OpenList failure onto the engine's neutral error contract. `code` is
 * the envelope code when the body parsed, else the HTTP status.
 */
const toFileSyncError = (
  operation: string,
  code: number,
  message: string,
  status?: number,
): FileSyncError => {
  let kind: FileSyncError['code'] = 'UNKNOWN';
  if (code === HTTP_UNAUTHORIZED) kind = 'AUTH_FAILED';
  else if (code === HTTP_NOT_FOUND || NOT_FOUND_RE.test(message)) kind = 'NOT_FOUND';
  else if (code === 408 || code === 429 || (code >= 500 && !NOT_FOUND_RE.test(message))) {
    // A 500 is usually a driver fault (upstream storage unreachable), which is
    // transient far more often than it is a permanent programming error.
    kind = 'NETWORK';
  }
  return new FileSyncError(
    `OpenList ${operation} failed: ${message || `code ${code}`}`,
    kind,
    status ?? code,
  );
};

export class OpenListClient {
  private readonly baseUrl: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private loginPromise: Promise<string> | null = null;
  private readonly fetchFn: OpenListFetchFn;

  constructor(
    private readonly config: OpenListClientConfig,
    fetchFn?: OpenListFetchFn,
  ) {
    this.baseUrl = trimTrailingSlash(config.serverUrl);
    this.fetchFn =
      fetchFn ??
      ((isTauriAppPlatform() ? tauriFetch : globalThis.fetch.bind(globalThis)) as OpenListFetchFn);
  }

  /** Bearer header for callers that need to hit a route directly. */
  async authHeaders(force = false): Promise<Record<string, string>> {
    return { Authorization: await this.ensureToken(force) };
  }

  /**
   * Current token, logging in when absent or expired. `force` drops a token the
   * server just rejected. Single-flight: concurrent callers share one login.
   */
  async ensureToken(force = false): Promise<string> {
    if (force) {
      this.token = null;
      this.tokenExpiresAt = 0;
    }
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async login(): Promise<string> {
    if (!this.config.username) {
      throw new FileSyncError('OpenList username is empty', 'AUTH_FAILED');
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${API_PREFIX}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password,
        }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new FileSyncError(`OpenList login failed: ${message}`, 'NETWORK');
    }

    const body = (await res.json().catch(() => null)) as OpenListEnvelope<{
      token?: string;
    }> | null;
    const token = body?.data?.token;
    if (body?.code !== CODE_OK || !token) {
      // A rejected login IS an auth failure, whatever envelope code the server
      // chose (AList answers 400 for a bad password on some versions, 500 on
      // others, 401 on new ones). Reporting it as NETWORK would send the user
      // chasing their network instead of their credentials.
      throw new FileSyncError(
        `OpenList login failed: ${body?.message ?? `HTTP ${res.status}`}`,
        'AUTH_FAILED',
        res.status,
      );
    }
    this.token = token;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return token;
  }

  /**
   * `POST /api/<endpoint>` returning `data`. Retries once after a fresh login
   * when the server rejects the token, which is the only retry that can help —
   * a driver error is surfaced to the engine instead of being hammered.
   */
  async call<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.ensureToken(attempt > 0);
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}${API_PREFIX}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token },
          body: JSON.stringify(body),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new FileSyncError(`OpenList ${endpoint} failed: ${message}`, 'NETWORK');
      }

      // Some reverse proxies answer a bare 401 before OpenList sees the request.
      if (res.status === HTTP_UNAUTHORIZED && attempt === 0) continue;

      const envelope = (await res.json().catch(() => null)) as OpenListEnvelope<T> | null;
      if (!envelope) {
        throw new FileSyncError(
          `OpenList ${endpoint} returned a non-JSON response (HTTP ${res.status})`,
          res.ok ? 'UNKNOWN' : 'NETWORK',
          res.status,
        );
      }
      if (envelope.code === HTTP_UNAUTHORIZED && attempt === 0) continue;
      if (envelope.code !== CODE_OK) {
        throw toFileSyncError(endpoint, envelope.code, envelope.message ?? '', res.status);
      }
      return envelope.data as T;
    }
  }

  /**
   * `PUT /api/fs/put` with a raw body. `File-Path` carries the URL-encoded
   * absolute destination; `X-File-Size` is mandatory because browsers refuse to
   * let JS set `Content-Length`, and OpenList's stream handler needs a size
   * from one header or the other.
   */
  async put(path: string, body: ArrayBuffer | string, contentType: string): Promise<void> {
    const byteLength =
      typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;

    for (let attempt = 0; ; attempt++) {
      const headers = {
        ...(await this.authHeaders(attempt > 0)),
        'File-Path': encodePath(path),
        'X-File-Size': String(byteLength),
        'Content-Type': contentType,
        // Synchronous upload: the engine awaits the write, and an async task
        // would hand it a "queued" success it cannot verify.
        'As-Task': 'false',
        Overwrite: 'true',
      };

      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}${API_PREFIX}/fs/put`, {
          method: 'PUT',
          headers,
          body,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new FileSyncError(`OpenList upload failed: ${message}`, 'NETWORK');
      }

      if (res.status === HTTP_UNAUTHORIZED && attempt === 0) continue;

      const envelope = (await res.json().catch(() => null)) as OpenListEnvelope<null> | null;
      const code = envelope?.code ?? res.status;
      if (code === HTTP_UNAUTHORIZED && attempt === 0) continue;
      if (code !== CODE_OK) {
        throw toFileSyncError(
          'upload',
          code,
          envelope?.message ?? `HTTP ${res.status}`,
          res.status,
        );
      }
      return;
    }
  }

  /**
   * Streaming upload straight off the disk (Tauri only): hands the local path to
   * the native transfer plugin so a 500 MB book never enters the JS heap.
   */
  async putStream(
    path: string,
    localPath: string,
    upload: (url: string, localPath: string, headers: Map<string, string>) => Promise<void>,
    byteLength: number,
  ): Promise<void> {
    const token = await this.ensureToken();
    const headers = new Map<string, string>([
      ['Authorization', token],
      ['File-Path', encodePath(path)],
      ['X-File-Size', String(byteLength)],
      ['As-Task', 'false'],
      ['Overwrite', 'true'],
    ]);
    await upload(`${this.baseUrl}${API_PREFIX}/fs/put`, localPath, headers);
  }

  /**
   * `GET /p/<path>?sign=...` — OpenList's server-side proxy route. The signed
   * `/d/` route 302s to the underlying driver, which 403s on several providers
   * (115, Tianyi) without a Referer; the proxy cannot. Costs the server's
   * bandwidth, which is the right trade for reliability.
   */
  async download(path: string, sign?: string): Promise<Response | null> {
    const query = sign ? `?sign=${encodeURIComponent(sign)}` : '';
    const url = `${this.baseUrl}/p${encodePath(path)}${query}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: 'GET', headers: await this.authHeaders() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new FileSyncError(`OpenList download failed: ${message}`, 'NETWORK');
    }
    if (res.status === HTTP_NOT_FOUND) return null;
    if (!res.ok) {
      throw new FileSyncError(
        `OpenList download failed: HTTP ${res.status} for ${path}`,
        res.status === HTTP_UNAUTHORIZED ? 'AUTH_FAILED' : 'NETWORK',
        res.status,
      );
    }
    return res;
  }

  /** Absolute URL of the proxy download route, for the native streaming path. */
  downloadUrl(path: string, sign?: string): string {
    const query = sign ? `?sign=${encodeURIComponent(sign)}` : '';
    return `${this.baseUrl}/p${encodePath(path)}${query}`;
  }
}
