import type { Locale, Theme } from "@tavern/shared";
import { UserSettings } from "@tavern/shared";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ApiError, apiClient } from "@/lib/apiClient";
import { errorMessage } from "@/lib/errorMessage";
import { m } from "@/paraglide/messages.js";
import { useSettingsStore } from "@/stores/settings";

// FR-06/FR-07/FR-16 persistence: any change in the App or Notifications section writes the FULL
// camelCase settings row (validated against the shared `UserSettings` zod) to PUT /api/me/settings.
// Reads the CURRENT store (setters run synchronously before this) so the row already reflects the edit.
export async function persistSettings(): Promise<void> {
  const s = useSettingsStore.getState();
  try {
    await apiClient.put("/api/me/settings", UserSettings, {
      notifyAll: s.notifyAll,
      notifyMentions: s.notifyMentions,
      locale: s.locale,
      theme: s.theme,
    });
  } catch (err) {
    if (err instanceof ApiError) toast(errorMessage(err.code));
  }
}

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "uk";
}

const THEME_OPTIONS: { value: Theme; label: () => string }[] = [
  { value: "light", label: () => m.settings_app_theme_light() },
  { value: "dark", label: () => m.settings_app_theme_dark() },
  { value: "system", label: () => m.settings_app_theme_system() },
];

// Language endonyms are shown in their own script (standard picker UX) and are deliberately not
// translated; kept in a plain const map (never JSX text) so they stay out of the m.*() catalog.
const LANGUAGE_ENDONYMS: Record<string, string> = { en: "English", uk: "Українська" };

export function AppSection() {
  const theme = useSettingsStore((s) => s.theme);
  const locale = useSettingsStore((s) => s.locale);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setLocale = useSettingsStore((s) => s.setLocale);

  return (
    <div data-testid="settings-app" className="flex flex-col gap-5 py-2">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{m.settings_app_theme()}</span>
        <RadioGroup
          value={theme}
          data-testid="settings-theme"
          onValueChange={(value) => {
            if (!isTheme(value)) return;
            setTheme(value);
            void persistSettings();
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <RadioGroupItem value={option.value} data-testid={`theme-option-${option.value}`} />
              <span>{option.label()}</span>
            </label>
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{m.settings_app_language()}</span>
        <Select
          value={locale}
          items={LANGUAGE_ENDONYMS}
          onValueChange={(value) => {
            if (!isLocale(value)) return;
            setLocale(value);
            void persistSettings();
          }}
        >
          <SelectTrigger data-testid="settings-language" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en" data-testid="lang-option-en">
              {LANGUAGE_ENDONYMS.en}
            </SelectItem>
            <SelectItem value="uk" data-testid="lang-option-uk">
              {LANGUAGE_ENDONYMS.uk}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
