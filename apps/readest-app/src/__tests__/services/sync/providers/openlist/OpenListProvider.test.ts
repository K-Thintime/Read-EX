// @vitest-environment happy-dom
import { describe, test, expect } from 'vitest';
import { normalizeServerUrl } from '@/services/sync/providers/openlist/openListClient';
import { createOpenListProvider } from '@/services/sync/providers/openlist/OpenListProvider';
import { FileSyncError } from '@/services/sync/file/provider';

/**
 * OpenList backend tests over an injected `fetch`.
 *
 * These do NOT reuse `file/providerSemanticContract.ts`: that harness stages a
 * scenario by HTTP STATUS (404 / 401), while OpenList reports both inside a
 * 200-response envelope (`{code: 404}` / `{code: 401}`). The invariants it
 * guards are asserted here explicitly instead, plus the OpenList-specific
 * mapping (body-coded errors, `File-Path` upload header, bottom-up deletes).
 */

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Mode = 'ok' | 'absent' | 'auth' | 'badPassword' | 'driverError';

const makeWire = () => {
  const calls: RecordedCall[] = [];
  let mode: Mode = 'ok';
  let tokensIssued = 0;

  /** Directory listing returned by `fs/list` in `ok` mode. */
  let listing: Array<{ name: string; size: number; is_dir: boolean; modified: string }> = [];
  /** Result of `fs/get` in `ok` mode. */
  let stat: { name: string; size: number; is_dir: boolean; sign?: string } | null = null;
  /** Body served by the `/p` proxy route. */
  let fileBody = 'hello';

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    // Record the headers EXACTLY as handed to fetch (openlist reads File-Path /
    // X-File-Size case-sensitively on the server side for some drivers).
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === 'object' && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k] = String(v);
    } else if (raw) {
      new Headers(raw as HeadersInit).forEach((v, k) => {
        headers[k] = v;
      });
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });

    if (url.endsWith('/api/auth/login')) {
      if (mode === 'badPassword') {
        return json({ code: 400, message: 'wrong password' });
      }
      tokensIssued += 1;
      return json({ code: 200, message: 'success', data: { token: `tk-${tokensIssued}` } });
    }

    if (url.includes('/api/fs/get')) {
      if (mode === 'absent') return json({ code: 500, message: 'object not found' });
      return json({ code: 200, message: 'success', data: stat });
    }

    if (url.includes('/api/fs/list')) {
      if (mode === 'absent') return json({ code: 500, message: 'object not found' });
      // Real servers wrap the array in `{ content, total, ... }`.
      return json({
        code: 200,
        message: 'success',
        data: { content: listing.length ? listing : null },
      });
    }

    if (url.includes('/api/fs/mkdir') || url.includes('/api/fs/remove')) {
      if (mode === 'driverError') return json({ code: 500, message: 'driver exploded' });
      return json({ code: 200, message: 'success', data: null });
    }

    if (url.includes('/api/fs/put')) {
      if (mode === 'auth') return json({ code: 401, message: 'token is invalidated' });
      return json({ code: 200, message: 'success', data: null });
    }

    // /p proxy download route (plain text, not JSON).
    if (new URL(url).pathname.startsWith('/p/') || url.includes('/p/')) {
      return new Response(fileBody, { status: 200 });
    }

    return json({ code: 404, message: `unmapped ${url}` });
  };

  return {
    fetchFn,
    calls,
    setMode: (m: Mode) => {
      mode = m;
    },
    setListing: (v: typeof listing) => {
      listing = v;
    },
    setStat: (v: typeof stat) => {
      stat = v;
    },
    setFileBody: (v: string) => {
      fileBody = v;
    },
    tokensIssued: () => tokensIssued,
  };
};

const config = {
  serverUrl: 'https://openlist.test',
  username: 'alice',
  password: 'secret',
  rootPath: '/onedrive/Readest',
};

const build = () => {
  const wire = makeWire();
  const provider = createOpenListProvider(config, wire.fetchFn);
  return { wire, provider };
};

describe('OpenListProvider — read/head mapping', () => {
  test('exposes the normalised root path', () => {
    expect(createOpenListProvider({ ...config, rootPath: 'onedrive/Readest/' }).rootPath).toBe(
      '/onedrive/Readest',
    );
  });

  test('readText returns null when fs/get reports not-found in a 200 envelope', async () => {
    const { wire, provider } = build();
    wire.setMode('absent');
    // HTTP 200 + code 500 "object not found" — a status-only check would treat
    // this as a successful empty body.
    expect(await provider.readText('/onedrive/Readest/Readest/library.json')).toBeNull();
  });

  test('head returns the fs/get size', async () => {
    const { wire, provider } = build();
    wire.setStat({ name: 'library.json', size: 1234, is_dir: false });
    expect(await provider.head('/onedrive/Readest/Readest/library.json')).toEqual({ size: 1234 });
  });

  test('readBinary streams from the /p proxy with the returned sign', async () => {
    const { wire, provider } = build();
    wire.setStat({ name: 'book.epub', size: 5, is_dir: false, sign: 'sg' });
    wire.setFileBody('hello');

    const buffer = await provider.readBinary('/onedrive/Readest/Readest/books/h/book.epub');
    expect(new TextDecoder().decode(buffer!)).toBe('hello');

    const download = wire.calls.find((c) => c.url.includes('/p/'));
    expect(download?.url).toBe(
      'https://openlist.test/p/onedrive/Readest/Readest/books/h/book.epub?sign=sg',
    );
  });

  test('list maps OpenList entries onto FileEntry with absolute paths', async () => {
    const { wire, provider } = build();
    wire.setListing([
      { name: 'books', size: 0, is_dir: true, modified: '2026-01-01T00:00:00Z' },
      { name: 'library.json', size: 42, is_dir: false, modified: '2026-01-02T00:00:00Z' },
    ]);

    const entries = await provider.list('/onedrive/Readest/Readest');
    expect(entries).toEqual([
      {
        name: 'books',
        path: '/onedrive/Readest/Readest/books',
        isDirectory: true,
        size: 0,
        lastModified: '2026-01-01T00:00:00Z',
      },
      {
        name: 'library.json',
        path: '/onedrive/Readest/Readest/library.json',
        isDirectory: false,
        size: 42,
        lastModified: '2026-01-02T00:00:00Z',
      },
    ]);
  });

  test('an empty directory (content: null) lists as []', async () => {
    const { provider } = build();
    expect(await provider.list('/onedrive/Readest/Readest/books')).toEqual([]);
  });

  test('list reads the real { content } envelope shape', async () => {
    // Regression: the wire used to mock `data` as a bare array, which passed
    // every test while the real server answered `data: { content: [...] }` -
    // the provider then called .map on an object ("e.map is not a function").
    const { wire, provider } = build();
    wire.setListing([{ name: 'books', size: 0, is_dir: true, modified: '2026-01-01T00:00:00Z' }]);
    const entries = await provider.list('/onedrive/Readest/Readest');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('books');
  });

  test('list tolerates a bare-array data shape (older forks)', async () => {
    const wire = makeWire();
    const fetchBareArray = async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/api/fs/list')) {
        return new Response(
          JSON.stringify({
            code: 200,
            message: 'success',
            data: [{ name: 'books', size: 0, is_dir: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return wire.fetchFn(input, init);
    };
    const p = createOpenListProvider(config, fetchBareArray);
    const entries = await p.list('/onedrive/Readest/Readest');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isDirectory).toBe(true);
  });
});

describe('OpenListProvider — auth handling', () => {
  test('a rejected password is AUTH_FAILED, not NETWORK', async () => {
    const { wire, provider } = build();
    wire.setMode('badPassword');
    const err = await provider.list('/onedrive/Readest').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileSyncError);
    expect((err as FileSyncError).code).toBe('AUTH_FAILED');
  });

  test('reuses one token across calls (single login)', async () => {
    const { wire, provider } = build();
    wire.setStat({ name: 'library.json', size: 1, is_dir: false });
    await provider.head('/onedrive/Readest/Readest/library.json');
    await provider.head('/onedrive/Readest/Readest/library.json');
    expect(wire.tokensIssued()).toBe(1);
  });

  test('a 401 in the body triggers exactly one forced re-login', async () => {
    const { wire, provider } = build();
    // Populate the token first, then fail the PUT with an invalidated token:
    // the retry must mint a second token rather than loop.
    wire.setStat({ name: 'x', size: 1, is_dir: false });
    await provider.head('/onedrive/Readest/Readest/x');
    wire.setMode('auth');

    const err = await provider.writeText('/onedrive/Readest/Readest/x.json', '{}').catch((e) => e);
    expect(err).toBeInstanceOf(FileSyncError);
    expect((err as FileSyncError).code).toBe('AUTH_FAILED');
    expect(wire.tokensIssued()).toBe(2);
  });
});

describe('OpenListProvider — writes and directories', () => {
  test('writeText uploads with the URL-encoded File-Path and X-File-Size headers', async () => {
    const { wire, provider } = build();
    await provider.writeText('/onedrive/Readest/Readest/a b.json', '{"k":1}');

    const put = wire.calls.find((c) => c.url.endsWith('/api/fs/put'));
    expect(put?.method).toBe('PUT');
    expect(put?.headers['File-Path']).toBe('/onedrive/Readest/Readest/a%20b.json');
    expect(put?.headers['X-File-Size']).toBe('7');
    expect(put?.headers['Overwrite']).toBe('true');
  });

  test('ensureDir creates each ancestor top-down', async () => {
    const { wire, provider } = build();
    await provider.ensureDir(['/onedrive', '/onedrive/Readest', '/onedrive/Readest/books']);

    const mkdirs = wire.calls
      .filter((c) => c.url.endsWith('/api/fs/mkdir'))
      .map((c) => JSON.parse(c.body!).path);
    expect(mkdirs).toEqual(['/onedrive', '/onedrive/Readest', '/onedrive/Readest/books']);
  });

  test('ensureDir treats an already-existing directory as success', async () => {
    const { wire, provider } = build();
    wire.setMode('driverError');
    wire.setStat({ name: 'Readest', size: 0, is_dir: true });
    // mkdir fails, then the fs/get probe proves the directory exists.
    await expect(provider.ensureDir(['/onedrive/Readest'])).resolves.toBeUndefined();
  });

  test('deleteDir removes the subtree bottom-up', async () => {
    const wire = makeWire();
    const removed: Array<{ dir: string; names: string[] }> = [];
    const fetchWithTrap = async (input: string, init?: RequestInit) => {
      if (String(input).endsWith('/api/fs/list')) {
        const path = JSON.parse(String(init?.body)).path as string;
        const children = path.endsWith('/books')
          ? [{ name: 'h', size: 0, is_dir: true }]
          : path.endsWith('/h')
            ? [{ name: 'book.epub', size: 5, is_dir: false }]
            : [];
        return new Response(
          JSON.stringify({
            code: 200,
            message: 'success',
            data: { content: children.length ? children : null },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const res = await wire.fetchFn(input, init);
      if (String(input).endsWith('/api/fs/remove')) {
        removed.push(JSON.parse(String(init?.body)));
      }
      return res;
    };

    const p = createOpenListProvider(config, fetchWithTrap);
    await p.deleteDir('/onedrive/Readest/Readest/books');

    expect(removed).toEqual([
      { dir: '/onedrive/Readest/Readest/books/h', names: ['book.epub'] },
      { dir: '/onedrive/Readest/Readest/books', names: ['h'] },
      { dir: '/onedrive/Readest/Readest', names: ['books'] },
    ]);
  });

  test('deleteDir on a missing subtree is success', async () => {
    const { wire, provider } = build();
    wire.setMode('absent');
    await expect(provider.deleteDir('/onedrive/Readest/Readest/books')).resolves.toBeUndefined();
  });
});

describe('normalizeServerUrl', () => {
  test('assumes http for a bare host:port, which is what users type', () => {
    // `192.168.1.9:5244` is not a valid URL - fetch rejects it and the form
    // used to report the rejection as an opaque "network error".
    expect(normalizeServerUrl('192.168.1.9:5244')).toBe('http://192.168.1.9:5244');
    expect(normalizeServerUrl('openlist.example.com')).toBe('http://openlist.example.com');
  });

  test('keeps an explicit scheme and case as written', () => {
    expect(normalizeServerUrl('https://drive.example.com')).toBe('https://drive.example.com');
    expect(normalizeServerUrl('HTTPS://Drive.Example.com')).toBe('HTTPS://Drive.Example.com');
  });

  test('strips trailing slashes so paths do not double up', () => {
    expect(normalizeServerUrl('https://drive.example.com///')).toBe('https://drive.example.com');
    expect(normalizeServerUrl('  http://10.0.0.2:5244/  ')).toBe('http://10.0.0.2:5244');
  });

  test('does not invent a host for empty input', () => {
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl(undefined)).toBe('');
    expect(normalizeServerUrl('   ')).toBe('');
  });
});
