/** Top-bar language switcher. Toggles between zh / en; choice is persisted by
 * the i18n LanguageDetector (localStorage). */
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "../i18n";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = i18n.resolvedLanguage;

  return (
    <div className="lang-switcher" role="group" aria-label={t("lang.switch")}>
      {SUPPORTED_LANGUAGES.map((lng) => (
        <button
          key={lng}
          type="button"
          className={current === lng ? "lang-btn active" : "lang-btn"}
          onClick={() => void i18n.changeLanguage(lng)}
        >
          {t(`lang.${lng}`)}
        </button>
      ))}
    </div>
  );
}
