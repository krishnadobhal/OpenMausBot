export function nativeSpeechLocale(value) {
  if (typeof value !== "string" || value.length > 100 || !/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(value)) return undefined;
  try {
    const locale = new Intl.Locale(value);
    return !locale.language || locale.language === "und" ? undefined : locale.baseName;
  } catch {
    return undefined;
  }
}

export function speechLocaleArguments(value) {
  if (value === undefined) return [];
  const locale = nativeSpeechLocale(value);
  if (!locale) throw new RangeError("unsupported-language");
  return ["--locale", locale];
}

export function shortcutSpeechLocale(choice, inherited, system) {
  const selected = choice ?? inherited ?? "";
  return nativeSpeechLocale(selected || system);
}
