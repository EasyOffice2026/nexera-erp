import { useTranslation } from 'react-i18next';
import { secondaryButtonClass } from '../components/ui';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <button
      type="button"
      className={secondaryButtonClass}
      onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
    >
      {t('common.otherLanguage')}
    </button>
  );
}
