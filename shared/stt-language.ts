/** Optional canonical BCP 47 language hint for a recorded speech upload. */
export const STT_LANGUAGE_HEADER = "x-omb-stt-language";

/** Canonical BCP 47 speech locale, or undefined for absent or invalid input. */
export function canonicalSpeechLocale(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 100 || !/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(value)) return undefined;
  try {
    const locale = Intl.getCanonicalLocales(value)[0];
    return locale?.split("-")[0] === "und" ? undefined : locale;
  } catch {
    return undefined;
  }
}

const TRANSCRIPTION_LANGUAGES = new Set(["de", "en", "es", "fr", "hi", "it", "ja", "ko", "pl", "pt", "ru", "tr", "uk", "vi", "zh"]);

/** ISO 639-1 hint for supported app languages; other valid locales retain provider detection. */
export function transcriptionLanguage(locale: unknown): string | undefined {
  const language = canonicalSpeechLocale(locale)?.split("-")[0];
  return language && TRANSCRIPTION_LANGUAGES.has(language) ? language : undefined;
}
