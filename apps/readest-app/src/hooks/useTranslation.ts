import '@/i18n/i18n';
import { useCallback } from 'react';
import { useTranslation as _useTranslation } from 'react-i18next';

export type TranslationFunc = (key: string, options?: Record<string, number | string>) => string;

// This fork ships as Read-EX, but every UI string comes from upstream
// translations that spell the old name out in all 34 locales. Rewriting the
// translated value renames the product everywhere at once; renaming the keys
// would only lose every existing translation.
//
// Two things are deliberately left alone:
//   - "Readest Cloud" - the hosted service at readest.com this app can still
//     sign into. Calling it Read-EX Cloud would imply a self-hosted backend
//     that does not exist.
//   - lowercase identifiers such as readest.com or readest:// URLs.
const APP_NAME = 'Read-EX';
const HOSTED_SERVICE = 'Readest Cloud';
const BRAND_PLACEHOLDER = '\u0000';

export const renameProduct = (text: string): string => {
  // t() can hand back a non-string when returnObjects is in play; leave those
  // alone rather than throwing on split().
  if (typeof text !== 'string' || !text.includes('Readest')) return text;
  return text
    .split(HOSTED_SERVICE)
    .join(BRAND_PLACEHOLDER)
    .replace(/Readest/g, APP_NAME)
    .split(BRAND_PLACEHOLDER)
    .join(HOSTED_SERVICE);
};

export const useTranslation = (namespace: string = 'translation') => {
  const { t } = _useTranslation(namespace);

  return useCallback(
    (key: string, options = {}) => renameProduct(t(key, { defaultValue: key, ...options })),
    [t],
  );
};
