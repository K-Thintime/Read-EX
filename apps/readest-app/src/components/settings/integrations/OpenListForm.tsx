import clsx from 'clsx';
import React, { useState } from 'react';
import { MdArrowUpward, MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation, type TranslationFunc } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { FileSyncError } from '@/services/sync/file/provider';
import { normalizeServerUrl, parentOf } from '@/services/sync/providers/openlist/openListClient';
import { createOpenListProvider } from '@/services/sync/providers/openlist/OpenListProvider';
import { SectionTitle } from '../primitives';
import FileSyncForm from './FileSyncForm';
import { persistCloudProviderEnabled } from './cloudSync';

/**
 * Translate a connection-probe failure into a user-facing string. Each branch is
 * a literal `_('...')` call so the i18next-scanner picks the keys up.
 *
 * The underlying `FileSyncError` message is appended on purpose: it carries what
 * actually went wrong (`Failed to fetch`, `certificate verify failed`, an
 * `invalid URL`, …). Collapsing everything into "Network error" makes a typo in
 * the host look identical to a TLS problem, and there is no way for the user -
 * or a bug report - to tell them apart.
 */
const formatConnectError = (_: TranslationFunc, e: unknown): string => {
  if (e instanceof FileSyncError) {
    const detail = e.message.replace(/^OpenList\s+\S+\s+failed:\s*/i, '').trim();
    switch (e.code) {
      case 'AUTH_FAILED':
        return detail ? `${_('Authentication failed')}: ${detail}` : _('Authentication failed');
      case 'NOT_FOUND':
        return _('Directory not found');
      case 'NETWORK':
        return detail ? `${_('Network error')}: ${detail}` : _('Network error');
    }
    if (typeof e.status === 'number') {
      return _('Unexpected server response (status {{status}})', { status: e.status });
    }
    return detail || _('Network error');
  }
  if (e instanceof Error && e.message) return e.message;
  return _('Network error');
};

const joinLabel = (path: string): string => (path === '/' ? '/' : path);

/** Host part of the server URL, for the "Connected as user@host" label. */
const serverHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * OpenList provider panel, embedded in the Integrations OpenList sub-page (which
 * owns the header). Same two states as {@link S3Form}:
 *
 * - **Active** (`openlist.enabled`): the shared {@link FileSyncForm} controls +
 *   a Disconnect button.
 * - **Inactive**: server / account / root-directory form.
 *
 * The root directory gets a dedicated browser rather than a bare text input
 * because OpenList's `/` is a MOUNT LIST: it lists storages but cannot hold
 * files, so a root of `/` connects fine and then fails on the first write. The
 * browser makes the user land inside a storage.
 */
const OpenListForm: React.FC = () => {
  const _ = useTranslation();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { envConfig } = useEnv();

  const stored = settings.openlist;
  const isActive = !!stored?.enabled;

  const [serverUrl, setServerUrl] = useState(stored?.serverUrl || '');
  const [username, setUsername] = useState(stored?.username || '');
  const [password, setPassword] = useState(stored?.password || '');
  const [rootPath, setRootPath] = useState(stored?.rootPath || '');
  const [showPassword, setShowPassword] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const [browsing, setBrowsing] = useState(false);
  const [browsePath, setBrowsePath] = useState('/');
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  const connectionReady = !!(serverUrl && username && password);
  const canSubmit = connectionReady && !!rootPath;

  const draft = () => ({
    serverUrl: normalizeServerUrl(serverUrl),
    username: username.trim(),
    password,
    rootPath: rootPath.trim() || '/',
  });

  /** List the sub-directories of `path` — also validates the credentials. */
  const loadDirs = async (path: string) => {
    setBrowseLoading(true);
    try {
      const provider = createOpenListProvider({ ...draft(), rootPath: path });
      const entries = await provider.list(path);
      setBrowseDirs(
        entries
          .filter((e) => e.isDirectory && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: e.path }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setBrowsePath(path);
    } catch (e) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: `${_('Failed to connect')}: ${formatConnectError(_, e)}`,
      });
      setBrowsing(false);
    } finally {
      setBrowseLoading(false);
    }
  };

  const handleBrowse = async () => {
    if (!connectionReady) return;
    setBrowsing(true);
    await loadDirs(rootPath || '/');
  };

  const handleConnect = async () => {
    if (!canSubmit) return;
    setIsConnecting(true);
    const config = draft();
    try {
      // One listing inside the chosen root proves credentials, reachability, and
      // that the root is a real directory rather than the mount list.
      const provider = createOpenListProvider(config);
      await provider.list(provider.rootPath);
    } catch (e) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: `${_('Failed to connect')}: ${formatConnectError(_, e)}`,
      });
      setIsConnecting(false);
      return;
    }
    await persistCloudProviderEnabled(envConfig, 'openlist', true, (s) => ({
      ...s,
      openlist: {
        ...s.openlist,
        ...config,
        accountLabel: `${config.username}@${serverHost(config.serverUrl)}`,
      },
    }));
    setIsConnecting(false);
    setBrowsing(false);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Connected') });
  };

  const handleDisconnect = async () => {
    // Switch this backend off only; credentials stay so a reconnect is one click.
    await persistCloudProviderEnabled(envConfig, 'openlist', false);
    setShowPassword(false);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Disconnected') });
  };

  const persistOpenList = async (patch: Partial<typeof stored>) => {
    const latest = useSettingsStore.getState().settings;
    const next = { ...latest, openlist: { ...latest.openlist, ...patch } };
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  if (isActive) {
    return (
      <div className='space-y-5'>
        <FileSyncForm kind='openlist' stored={stored} persist={persistOpenList} />

        <div className='flex justify-end'>
          <button
            type='button'
            onClick={handleDisconnect}
            className={clsx(
              'eink-bordered',
              'h-10 rounded-lg px-4 text-sm font-medium',
              'text-error hover:bg-error/10',
              'transition-colors duration-150',
              'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
            )}
          >
            {_('Disconnect')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className='space-y-4'
      onSubmit={(e) => {
        e.preventDefault();
        handleConnect();
      }}
    >
      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='openlist-server' className='block'>
          {_('Server URL')}
        </SectionTitle>
        <input
          id='openlist-server'
          type='text'
          placeholder='https://openlist.example.com'
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          spellCheck='false'
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='openlist-username' className='block'>
          {_('Username')}
        </SectionTitle>
        <input
          id='openlist-username'
          type='text'
          placeholder={_('Your OpenList username')}
          className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
          spellCheck='false'
          autoComplete='off'
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='openlist-password' className='block'>
          {_('Password')}
        </SectionTitle>
        <div className='relative'>
          <input
            id='openlist-password'
            type={showPassword ? 'text' : 'password'}
            placeholder={_('Your OpenList password')}
            className='input eink-bordered h-11 w-full pe-11 text-sm focus:outline-hidden'
            autoComplete='off'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type='button'
            onClick={() => setShowPassword((v) => !v)}
            className={clsx(
              'absolute end-2 top-1/2 -translate-y-1/2',
              'flex h-8 w-8 items-center justify-center rounded-sm',
              'text-base-content/60 hover:text-base-content',
              'hover:bg-base-200/60 transition-colors duration-150',
              'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
            )}
            aria-label={showPassword ? _('Hide password') : _('Show password')}
            tabIndex={-1}
          >
            {showPassword ? (
              <MdVisibilityOff className='h-4 w-4' />
            ) : (
              <MdVisibility className='h-4 w-4' />
            )}
          </button>
        </div>
      </div>

      <div className='space-y-1.5'>
        <SectionTitle as='label' htmlFor='openlist-root' className='block'>
          {_('Sync directory')}
        </SectionTitle>
        <div className='flex gap-2'>
          <input
            id='openlist-root'
            type='text'
            placeholder='/onedrive/Readest'
            className='input eink-bordered h-11 min-w-0 flex-1 text-sm focus:outline-hidden'
            spellCheck='false'
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
          />
          <button
            type='button'
            disabled={!connectionReady}
            onClick={handleBrowse}
            className={clsx(
              'eink-bordered h-11 shrink-0 rounded-lg px-4 text-sm font-medium',
              'hover:bg-base-200/60 transition-colors duration-150',
              'disabled:opacity-50',
            )}
          >
            {_('Browse')}
          </button>
        </div>
        <p className='text-base-content/60 text-xs leading-relaxed'>
          {_(
            'Pick a folder inside one of your storage mounts. The server root itself cannot hold files.',
          )}
        </p>
      </div>

      {browsing && (
        <div className='rounded-lg border border-base-300'>
          <div className='flex items-center gap-2 border-b border-base-300 px-2 py-1.5'>
            <button
              type='button'
              disabled={browsePath === '/' || browseLoading}
              onClick={() => loadDirs(parentOf(browsePath))}
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-sm',
                'hover:bg-base-200/60 disabled:opacity-40',
              )}
              aria-label={_('Up one level')}
            >
              <MdArrowUpward className='h-4 w-4' />
            </button>
            <span className='truncate font-mono text-xs'>{joinLabel(browsePath)}</span>
            <button
              type='button'
              onClick={() => {
                setRootPath(browsePath);
                setBrowsing(false);
              }}
              className='text-primary ms-auto shrink-0 text-xs font-medium'
            >
              {_('Use this folder')}
            </button>
          </div>
          <div className='max-h-52 overflow-y-auto py-1'>
            {browseLoading ? (
              <div className='flex justify-center py-4'>
                <span className='loading loading-spinner loading-sm' />
              </div>
            ) : browseDirs.length === 0 ? (
              <p className='text-base-content/60 px-3 py-3 text-xs'>{_('No subfolders')}</p>
            ) : (
              browseDirs.map((dir) => (
                <button
                  key={dir.path}
                  type='button'
                  onClick={() => loadDirs(dir.path)}
                  className='hover:bg-base-200/60 flex w-full items-center px-3 py-1.5 text-start text-sm'
                >
                  {dir.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <div className='flex justify-end pt-1'>
        <button
          type='submit'
          disabled={isConnecting || !canSubmit}
          className={clsx(
            'btn btn-contrast',
            'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
            'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
            isConnecting && 'opacity-60',
          )}
        >
          {isConnecting ? <span className='loading loading-spinner loading-sm' /> : _('Connect')}
        </button>
      </div>
    </form>
  );
};

export default OpenListForm;
