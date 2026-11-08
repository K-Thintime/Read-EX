/**
 * One-shot migration: books that live in Readest Cloud -> a third-party drive.
 *
 * Why this exists: the file-sync backends (WebDAV / S3 / Drive / OneDrive /
 * iCloud / OpenList) each reconcile against the LOCAL library. A book that was
 * uploaded to Readest Cloud from another device and never downloaded here is
 * invisible to them, so switching a mirror on leaves the cloud-only half of the
 * shelf behind and nobody notices until the day they open that device offline.
 *
 * The shape of the fix follows from that: the safe path is cloud -> local
 * library -> existing push pass, not a provider-to-provider copy. Copying
 * straight into a drive would mean re-deriving the backend's directory layout
 * and its `library.json` index, and a partial index write is far more damaging
 * than a slow migration.
 *
 * Consequences worth knowing:
 * - The books end up on this device too (they are downloaded, not streamed).
 * - Idempotent: a second run finds nothing missing and only runs the push.
 */
import type { TranslationFunc } from '@/hooks/useTranslation';
import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { EnvConfigType } from '@/services/environment';
import { SyncClient } from '@/libs/sync';
import { getEnabledFileSyncBackends } from '@/services/sync/cloudSyncProvider';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import { runFileLibrarySyncPass } from '@/services/sync/file/runLibrarySync';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

export interface CloudBooksMigrationProgress {
  phase: 'list' | 'download' | 'push';
  /** Items finished in this phase. */
  done: number;
  /** Items in this phase; 1 for the single-shot phases. */
  total: number;
  /** Book title currently being fetched, for the progress line. */
  label?: string;
}

export interface CloudBooksMigrationResult {
  /** Live book rows the cloud reported. */
  cloudBooks: number;
  /** Of those, the ones this device had never seen. */
  missingLocally: number;
  downloaded: number;
  failed: { title: string; error: string }[];
  /** Third-party backends the push pass covered. */
  backends: FileSyncBackendKind[];
}

/**
 * Copy every cloud book the local library lacks, then push the whole library to
 * the enabled backends.
 *
 * Throws when there is nothing to push INTO, when the account is signed out
 * (`pullChanges` rejects with 'Not authenticated'), or when the library has not
 * finished loading - pushing an empty index would clobber the remote.
 */
export const migrateCloudBooksToBackends = async (
  appService: AppService,
  envConfig: EnvConfigType,
  _: TranslationFunc,
  onProgress?: (progress: CloudBooksMigrationProgress) => void,
): Promise<CloudBooksMigrationResult> => {
  const settings = useSettingsStore.getState().settings;
  const backends = getEnabledFileSyncBackends(settings);
  if (backends.length === 0) {
    throw new Error(_('Turn on a cloud storage backend first'));
  }
  if (!useLibraryStore.getState().libraryLoaded) {
    throw new Error(_('The library is still loading, try again in a moment'));
  }

  onProgress?.({ phase: 'list', done: 0, total: 1 });

  const client = new SyncClient();
  const { books: records } = await client.pullChanges(0, 'books');
  // Tombstones carry the deletion, not a book. Migrating them would resurrect
  // shelves the user removed.
  const cloudBooks = (records ?? []).filter((record) => !record.deletedAt);

  const library = useLibraryStore.getState().library;
  const localHashes = new Set(library.filter((book) => !book.deletedAt).map((book) => book.hash));
  const missing = cloudBooks.filter((record) => !localHashes.has(record.hash)) as unknown as Book[];

  // Shelf rows BEFORE files: the push pass builds its index from the library,
  // so a file downloaded without a row would never reach the drive.
  if (missing.length > 0) {
    const merged = [...library, ...missing];
    useLibraryStore.getState().setLibrary(merged);
    await appService.saveLibraryBooks(merged);
  }

  let downloaded = 0;
  const failed: { title: string; error: string }[] = [];
  for (let i = 0; i < missing.length; i++) {
    const book = missing[i]!;
    onProgress?.({ phase: 'download', done: i, total: missing.length, label: book.title });
    try {
      await appService.downloadBook(book, false, false);
      downloaded++;
    } catch (error) {
      // One unreadable book must not strand the other ninety.
      failed.push({
        title: book.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onProgress?.({ phase: 'push', done: 0, total: 1 });
  await runFileLibrarySyncPass(envConfig, _);

  return {
    cloudBooks: cloudBooks.length,
    missingLocally: missing.length,
    downloaded,
    failed,
    backends,
  };
};
