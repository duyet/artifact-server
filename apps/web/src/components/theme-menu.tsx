import {IconDeviceDesktop, IconMoon, IconSun} from "@tabler/icons-react";

import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {useTheme} from "@/hooks/use-theme";
import {themePreferences, type ThemePreference} from "@/lib/theme";

const themeOptions = {
  dark: {icon: IconMoon, label: "Dark"},
  light: {icon: IconSun, label: "Light"},
  system: {icon: IconDeviceDesktop, label: "System"},
} as const satisfies Record<ThemePreference, {icon: typeof IconSun; label: string}>;

/** Light, Dark, and System as radio items, for any dropdown menu. */
export function ThemeRadioGroup({
  onValueChange,
  value,
}: {
  readonly onValueChange: (preference: ThemePreference) => void;
  readonly value: ThemePreference;
}) {
  return (
    <DropdownMenuRadioGroup
      onValueChange={(next: ThemePreference) => onValueChange(next)}
      value={value}
    >
      {themePreferences.map((preference) => {
        const {icon: Icon, label} = themeOptions[preference];
        return (
          <DropdownMenuRadioItem closeOnClick key={preference} value={preference}>
            <Icon />
            {label}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/** A standalone theme switcher for pages without an account menu. */
export function ThemeMenu() {
  const {preference, resolved, setPreference} = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button aria-label="Theme" size="icon" variant="outline" />}
      >
        {resolved === "dark" ? <IconMoon /> : <IconSun />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ThemeRadioGroup onValueChange={setPreference} value={preference} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
