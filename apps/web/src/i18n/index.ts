import { type Language, languageSchema } from '@nexera/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';
import en from './locales/en.json';

const LANGUAGE_STORAGE_KEY = 'nexera.language';

// Browsers can block storage (private windows, blocked site data), so every access is guarded.
function readStoredLanguage(): Language | null {
  try {
    const parsed = languageSchema.safeParse(localStorage.getItem(LANGUAGE_STORAGE_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function detectLanguage(): Language {
  return readStoredLanguage() ?? (navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en');
}

// The page direction follows the language, so the whole layout mirrors for Arabic.
function applyDocumentLanguage(language: Language): void {
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
}

const initialLanguage = detectLanguage();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: ['en', 'ar'],
  interpolation: { escapeValue: false },
});

applyDocumentLanguage(initialLanguage);

i18n.on('languageChanged', (language: string) => {
  const parsed = languageSchema.safeParse(language);
  if (!parsed.success) return;
  applyDocumentLanguage(parsed.data);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, parsed.data);
  } catch {
    // Not saving the choice is fine.
  }
});

export default i18n;
