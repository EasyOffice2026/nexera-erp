import type en from './locales/en.json';

// Makes t('...') check that the key exists in the English file.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}
