import clsx from 'clsx';
import React, { useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import {
  cloudProviderDisplayName,
  getEnabledFileSyncBackends,
} from '@/services/sync/cloudSyncProvider';
import {
  migrateCloudBooksToBackends,
  type CloudBooksMigrationProgress,
  type CloudBooksMigrationResult,
} from '@/services/sync/migrate/cloudBooksToBackends';
import { SectionTitle } from '../primitives';

/**
 * "Move what is in Readest Cloud onto my own drive" — one shot, books only.
 *
 * Books that only ever lived in Readest Cloud are invisible to the file-sync
 * backends, which reconcile against the local library. This downloads the
 * missing ones and then lets the normal push pass mirror them.
 */
const CloudMigrationSection: React.FC = () => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings } = useSettingsStore();

  const backends = getEnabledFileSyncBackends(settings);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CloudBooksMigrationProgress | null>(null);
  const [result, setResult] = useState<CloudBooksMigrationResult | null>(null);

  const canRun = !!appService && !running && backends.length > 0;

  const handleMigrate = async () => {
    if (!canRun || !appService) return;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const migrated = await migrateCloudBooksToBackends(appService, envConfig, _, setProgress);
      setResult(migrated);
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Migration finished') });
    } catch (error) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: `${_('Migration failed')}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const progressText = (): string => {
    if (!progress) return _('Preparing…');
    if (progress.phase === 'list') return _('Reading your Readest Cloud library…');
    if (progress.phase === 'download') {
      return _('Downloading {{done}}/{{total}}: {{title}}', {
        done: progress.done + 1,
        total: progress.total,
        title: progress.label ?? '',
      });
    }
    return _('Uploading to your cloud storage…');
  };

  return (
    <div className='my-4'>
      <SectionTitle as='h3' className='mb-2'>
        {_('Move Readest Cloud books to your own drive')}
      </SectionTitle>
      <p className='text-base-content/70 mb-3 text-sm leading-relaxed'>
        {_(
          'Books stored in Readest Cloud are invisible to the storage backends below, because those only mirror what is already in this device’s library. This copies the missing books down once, then uploads the whole library to every backend that is switched on.',
        )}
      </p>

      {backends.length === 0 ? (
        <p className='text-warning text-sm'>
          {_('Turn on a cloud storage backend below first, then come back.')}
        </p>
      ) : (
        <p className='text-base-content/60 mb-3 text-xs'>
          {_('Targets: {{targets}}', {
            targets: backends.map((kind) => cloudProviderDisplayName(kind)).join(', '),
          })}
        </p>
      )}

      <div className='flex items-center gap-3'>
        <button
          type='button'
          onClick={handleMigrate}
          disabled={!canRun}
          className={clsx(
            'btn btn-contrast h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
            'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
            !canRun && 'opacity-60',
          )}
        >
          {running ? <span className='loading loading-spinner loading-sm' /> : _('Start migration')}
        </button>
        {running && <span className='text-base-content/70 text-sm'>{progressText()}</span>}
      </div>

      {result && (
        <div className='text-base-content/70 mt-3 space-y-1 text-sm'>
          <p>
            {_(
              'Readest Cloud holds {{cloud}} books; {{missing}} were missing on this device and {{downloaded}} of them were downloaded.',
              {
                cloud: result.cloudBooks,
                missing: result.missingLocally,
                downloaded: result.downloaded,
              },
            )}
          </p>
          {result.missingLocally > 0 && (
            <p>
              {_('The library is now syncing to: {{targets}}', {
                targets: result.backends.map((kind) => cloudProviderDisplayName(kind)).join(', '),
              })}
            </p>
          )}
          {result.failed.length > 0 && (
            <div className='text-warning'>
              <p>{_('Could not download {{count}} books:', { count: result.failed.length })}</p>
              <ul className='mt-1 list-inside list-disc text-xs'>
                {result.failed.slice(0, 5).map((item) => (
                  <li key={item.title}>
                    {item.title} — {item.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CloudMigrationSection;
