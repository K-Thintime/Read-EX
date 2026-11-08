import semver from 'semver';
import { check } from '@tauri-apps/plugin-updater';
import { type as osType, arch as osArch } from '@tauri-apps/plugin-os';
import { fetch } from '@tauri-apps/plugin-http';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ScrollBarStyle } from '@tauri-apps/api/window';
import { TranslationFunc } from '@/hooks/useTranslation';
import { setUpdaterWindowVisible } from '@/components/UpdaterWindow';
import { isTauriAppPlatform } from '@/services/environment';
import { getAppVersion, isUpdateNewer } from '@/utils/version';
import {
  READEST_CHANGELOG_FILE,
  READEST_LATEST_RELEASE_API,
  READEST_NIGHTLY_UPDATER_FILE,
  READEST_RELEASE_PAGE,
  READEST_UPDATER_FILE,
} from '@/services/constants';

const LAST_CHECK_KEY = 'lastAppUpdateCheck';
const IGNORED_VERSION_KEY = 'ignoredAppUpdateVersion';

// Auto-checks used to be throttled to one per 24 h, which meant a relaunch on
// the same day showed nothing even when a release had just gone out. The
// library and reader pages both call this on mount, so the guard is
// per-process: one check per app launch, however many pages mount.
let autoCheckedThisLaunch = false;

export const getIgnoredUpdateVersion = (): string => {
  try {
    return localStorage.getItem(IGNORED_VERSION_KEY) || '';
  } catch {
    return '';
  }
};

export const setIgnoredUpdateVersion = (version: string) => {
  try {
    localStorage.setItem(IGNORED_VERSION_KEY, version);
  } catch {
    // Private mode / storage disabled - ignoring a version is a convenience,
    // never a correctness requirement.
  }
};

export const clearIgnoredUpdateVersion = () => {
  try {
    localStorage.removeItem(IGNORED_VERSION_KEY);
  } catch {
    // see above
  }
};

/**
 * A version is ignored only when it is exactly the one the user skipped.
 *
 * The obvious "not newer than the ignored version" test would also swallow a
 * backported hotfix (skip 2.0.0 while on 1.9.0, then 1.9.1 ships and stays
 * silent). Equality on the parsed version - same core, same nightly stamp -
 * keeps the skip scoped to the release the user actually declined.
 */
export const isUpdateIgnored = (version: string): boolean => {
  const ignored = getIgnoredUpdateVersion();
  if (!ignored) return false;
  return !isUpdateNewer(version, ignored) && !isUpdateNewer(ignored, version);
};

/**
 * Test seam. The "one auto-check per launch" guard is module state and nothing
 * in production ever resets it - a new process is the reset.
 */
export const __resetUpdateCheckForTests = () => {
  autoCheckedThisLaunch = false;
};

const showUpdateWindow = (latestVersion: string, scrollBarStyle: ScrollBarStyle) => {
  const win = new WebviewWindow('updater', {
    url: `/updater?latestVersion=${latestVersion}`,
    title: 'Software Update',
    width: 626,
    height: 406,
    center: true,
    resizable: true,
    scrollBarStyle,
  });
  win.once('tauri://created', () => {
    console.log('new window created');
  });
  win.once('tauri://error', (e) => {
    console.error('error creating window', e);
  });
};

type FetchFn = typeof fetch;

export interface UpdateManifestEntry {
  url?: string;
  signature?: string;
}
export interface UpdateManifest {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, UpdateManifestEntry>;
}
export interface ResolvedNightlyUpdate {
  endpoint: string; // manifest URL (for the Tauri UpdaterBuilder path)
  version: string;
  notes?: string;
  pubDate?: string;
  platformKey: string;
  url: string; // artifact URL (for the custom install flows)
  signature: string; // artifact signature
}

export type ReleaseAssetKind = 'windows-exe' | 'android-apk' | 'linux-deb' | 'download-page';

/**
 * A newer release that tauri's own updater cannot install: Windows ships a bare
 * exe, Android a sideloaded apk. The window still offers a one-click install,
 * but the mechanics live in the app rather than in the plugin.
 */
export interface ResolvedReleaseAsset {
  version: string;
  notes?: string;
  pubDate?: string;
  pageUrl: string;
  assetUrl?: string;
  assetName?: string;
  kind: ReleaseAssetKind;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
}

const pickAsset = (assets: GithubAsset[], patterns: RegExp[]): GithubAsset | undefined => {
  for (const re of patterns) {
    const hit = assets.find((a) => re.test(a.name));
    if (hit) return hit;
  }
  return undefined;
};

const releaseAssetMatchers: Record<Exclude<ReleaseAssetKind, 'download-page'>, RegExp[]> = {
  // The single-file build is what the updater can launch in place; the zip is
  // only a fallback for a release that predates it.
  'windows-exe': [/_windows-x64\.exe$/i, /\.exe$/i],
  'android-apk': [/\.apk$/i],
  'linux-deb': [/\.deb$/i],
};

export type ReleaseAssetTarget = 'windows' | 'android' | 'linux' | 'any';

/**
 * Ask the GitHub releases API for the newest published release.
 *
 * This is the source of truth for "is there a new version" on platforms whose
 * installers tauri cannot self-update. Drafts and prereleases are skipped so a
 * half-finished release never prompts anyone; any failure reads as "no update"
 * because an update check has to stay best-effort.
 */
export const resolveReleaseUpdate = async (
  currentVersion: string,
  fetchFn: FetchFn,
  target: ReleaseAssetTarget = 'any',
): Promise<ResolvedReleaseAsset | null> => {
  let release: GithubRelease;
  try {
    const res = await fetchFn(READEST_LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      connectTimeout: 8000,
    } as RequestInit);
    if (!res.ok) return null;
    release = (await res.json()) as GithubRelease;
  } catch (err) {
    console.warn('Failed to fetch the latest GitHub release', err);
    return null;
  }
  const version = (release.tag_name || '').replace(/^v/, '');
  if (!version || release.draft || release.prerelease) return null;
  if (!isUpdateNewer(version, currentVersion)) return null;

  const assets = release.assets ?? [];
  const pageUrl = release.html_url || `${READEST_RELEASE_PAGE}/latest`;
  const candidateKinds: Array<Exclude<ReleaseAssetKind, 'download-page'>> =
    target === 'windows'
      ? ['windows-exe']
      : target === 'android'
        ? ['android-apk']
        : target === 'linux'
          ? ['linux-deb']
          : ['windows-exe', 'android-apk', 'linux-deb'];

  for (const kind of candidateKinds) {
    const asset = pickAsset(assets, releaseAssetMatchers[kind]);
    if (asset) {
      return {
        version,
        notes: release.body,
        pubDate: release.published_at,
        pageUrl,
        assetUrl: asset.browser_download_url,
        assetName: asset.name,
        kind,
      };
    }
  }

  // Nothing this device can install by itself - still worth saying a release
  // exists, with a link to the page.
  return {
    version,
    notes: release.body,
    pubDate: release.published_at,
    pageUrl,
    kind: 'download-page',
  };
};

// Android ships one APK per ABI group. osArch() reports the ABI of the loaded
// native library, so it picks the APK this install can actually run.
export const getAndroidPlatformKey = (osArchVal: string): string => {
  if (osArchVal === 'aarch64') return 'android-arm64';
  if (osArchVal === 'arm') return 'android-armv7';
  return 'android-legacy';
};

export const getNightlyPlatformKey = (
  osTypeVal: string,
  osArchVal: string,
  isPortable: boolean,
  isAppImage: boolean,
): string | null => {
  if (osTypeVal === 'android') return getAndroidPlatformKey(osArchVal);
  if (osTypeVal === 'macos') return osArchVal === 'aarch64' ? 'darwin-aarch64' : 'darwin-x86_64';
  // Match the arch explicitly so a 32-bit (or otherwise unknown) arch yields no
  // nightly rather than mis-routing to aarch64.
  if (osTypeVal === 'windows') {
    if (osArchVal === 'x86_64') return isPortable ? 'windows-x86_64-portable' : 'windows-x86_64';
    if (osArchVal === 'aarch64') return isPortable ? 'windows-aarch64-portable' : 'windows-aarch64';
    return null;
  }
  if (osTypeVal === 'linux') {
    // Nightly Linux is AppImage-only; a deb/rpm install has no nightly
    // artifact, so it cleanly gets no nightly rather than mis-routing.
    if (isAppImage) {
      if (osArchVal === 'x86_64') return 'linux-x86_64-appimage';
      if (osArchVal === 'aarch64') return 'linux-aarch64-appimage';
    }
    return null;
  }
  return null;
};

const fetchManifest = async (fetchFn: FetchFn, url: string): Promise<UpdateManifest | null> => {
  try {
    const res = await fetchFn(url, { connectTimeout: 5000 } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as UpdateManifest;
  } catch (err) {
    console.warn('Failed to fetch update manifest', url, err);
    return null;
  }
};

// Nightly channel resolution: fetch the nightly + stable manifests, keep only
// candidates that (a) have a usable artifact for this platform and (b) are newer
// than the installed version, then return the newest by the base-aware rule.
export const resolveNightlyUpdate = async (
  currentVersion: string,
  platformKey: string,
  fetchFn: FetchFn,
): Promise<ResolvedNightlyUpdate | null> => {
  const [nightly, stable] = await Promise.all([
    fetchManifest(fetchFn, READEST_NIGHTLY_UPDATER_FILE),
    fetchManifest(fetchFn, READEST_UPDATER_FILE),
  ]);
  const sources: Array<[UpdateManifest | null, string]> = [
    [nightly, READEST_NIGHTLY_UPDATER_FILE],
    [stable, READEST_UPDATER_FILE],
  ];
  const candidates: ResolvedNightlyUpdate[] = [];
  for (const [manifest, endpoint] of sources) {
    if (!manifest?.version) continue;
    const entry = manifest.platforms?.[platformKey];
    if (!entry?.url || !entry?.signature) continue; // platform-eligibility filter
    if (!isUpdateNewer(manifest.version, currentVersion)) continue;
    candidates.push({
      endpoint,
      version: manifest.version,
      notes: manifest.notes,
      pubDate: manifest.pub_date,
      platformKey,
      url: entry.url,
      signature: entry.signature,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    isUpdateNewer(a.version, b.version) ? -1 : isUpdateNewer(b.version, a.version) ? 1 : 0,
  );
  return candidates[0]!;
};

export const checkForAppUpdates = async (
  _: TranslationFunc,
  isAutoCheck = true,
  updateChannel: 'stable' | 'nightly' = 'stable',
): Promise<boolean> => {
  // One automatic check per launch. A manual check (About window) always runs.
  if (isAutoCheck) {
    if (autoCheckedThisLaunch) return false;
    autoCheckedThisLaunch = true;
  }
  try {
    localStorage.setItem(LAST_CHECK_KEY, Date.now().toString());
  } catch {
    // storage disabled - the timestamp is only informational
  }

  console.log('Checking for updates', { updateChannel });
  const OS_TYPE = osType();
  const currentVersion = getAppVersion();

  try {
    if (updateChannel === 'nightly') {
      const platformKey = getNightlyPlatformKey(
        OS_TYPE,
        osArch(),
        Boolean(process.env['NEXT_PUBLIC_PORTABLE_APP']),
        Boolean((window as { __READEST_IS_APPIMAGE?: boolean }).__READEST_IS_APPIMAGE),
      );
      if (!platformKey) return false;
      const resolved = await resolveNightlyUpdate(currentVersion, platformKey, fetch);
      if (resolved && !isUpdateIgnored(resolved.version)) {
        setUpdaterWindowVisible(true, resolved.version, currentVersion, true, resolved);
        return true;
      }
      return false;
    }

    if (['macos', 'windows', 'linux'].includes(OS_TYPE)) {
      // 1. The tauri updater: only knows about platforms whose bundle produced
      //    a signed updater artifact (macOS dmg on this fork).
      const update = await check();
      if (update) {
        if (isUpdateIgnored(update.version)) return false;
        // Enum ScrollBarStyle is exported as type by tauri, so it cannot be used directly.
        const scrollBarStyle = (OS_TYPE === 'windows'
          ? 'fluentOverlay'
          : 'default') as unknown as ScrollBarStyle;
        showUpdateWindow(update.version, scrollBarStyle);
        return true;
      }
      // 2. Everything else: ask GitHub directly. This is what makes the Windows
      //    portable build notice a new release at all.
      const release = await resolveReleaseUpdate(
        currentVersion,
        fetch,
        OS_TYPE === 'windows' ? 'windows' : 'linux',
      );
      if (release && !isUpdateIgnored(release.version)) {
        setUpdaterWindowVisible(true, release.version, currentVersion, true, undefined, release);
        return true;
      }
      return false;
    } else if (OS_TYPE === 'android') {
      try {
        const platformKey = getAndroidPlatformKey(osArch());
        const response = await fetch(READEST_UPDATER_FILE, { connectTimeout: 5000 });
        const data = (await response.json()) as UpdateManifest;
        if (isUpdateNewer(data.version, currentVersion) && platformKey in (data.platforms ?? {})) {
          if (isUpdateIgnored(data.version)) return false;
          setUpdaterWindowVisible(true, data.version, currentVersion);
          return true;
        }
        // latest.json only lists what tauri can install; the apk is not in it,
        // so fall through to the release API before concluding "up to date".
        const release = await resolveReleaseUpdate(currentVersion, fetch, 'android');
        if (release && !isUpdateIgnored(release.version)) {
          setUpdaterWindowVisible(true, release.version, currentVersion, true, undefined, release);
          return true;
        }
        return false;
      } catch (err) {
        console.warn('Failed to fetch Android update info', err);
        throw new Error('Failed to fetch Android update info');
      }
    }

    return false;
  } catch (err) {
    // Update checks are best-effort: they fail routinely when offline or when
    // the release host is unreachable. An auto-check runs fire-and-forget on
    // mount, so throwing here becomes an unhandled rejection (READEST-J desktop
    // latest.json, READEST-22 Android update info). Only surface the failure for
    // a manual check (About window).
    console.warn('Update check failed', err);
    if (!isAutoCheck) throw err;
    return false;
  }
};

const LAST_SHOWN_RELEASE_NOTES_KEY = 'lastShownReleaseNotesVersion';

export const setLastShownReleaseNotesVersion = (version: string) => {
  localStorage.setItem(LAST_SHOWN_RELEASE_NOTES_KEY, version);
};

export const getLastShownReleaseNotesVersion = () => {
  return localStorage.getItem(LAST_SHOWN_RELEASE_NOTES_KEY) || '';
};

export const checkAppReleaseNotes = async (isAutoCheck = true) => {
  const currentVersion = getAppVersion();
  const lastShownVersion = getLastShownReleaseNotesVersion();
  if ((lastShownVersion && semver.gt(currentVersion, lastShownVersion)) || !isAutoCheck) {
    try {
      const fetchFunc = isTauriAppPlatform() ? fetch : window.fetch;
      const res = await fetchFunc(READEST_CHANGELOG_FILE);
      if (res.ok) {
        setUpdaterWindowVisible(true, currentVersion, lastShownVersion, false);
        return true;
      }
    } catch (err) {
      console.warn('Failed to fetch release notes', err);
    }
  } else if (!lastShownVersion) {
    setLastShownReleaseNotesVersion(currentVersion);
  }
  return false;
};
