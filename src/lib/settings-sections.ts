export const SETTINGS_SECTIONS = [
  "general",
  "categories",
  "fields",
  "chapters",
  "import",
  "github",
  "discord",
  "team",
  "agents",
  "signin",
  "danger",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The sections a member can read. Agent credentials and archiving stay owner-only. */
const MEMBER_SECTIONS: readonly SettingsSection[] = ["general", "categories", "fields", "chapters", "team"];

/**
 * How people sign in belongs to the installation, not to a project.
 *
 * So it is the admin's, and it is the one section a project owner does not get: an owner
 * reshapes the board in front of them, and a provider reaches every board there is.
 */
const ADMIN_SECTIONS: readonly SettingsSection[] = ["signin"];

export function settingsSectionsFor(isOwner: boolean, isAdmin = false): readonly SettingsSection[] {
  const reachable = isOwner ? SETTINGS_SECTIONS : MEMBER_SECTIONS;
  return reachable.filter((section) => isAdmin || !ADMIN_SECTIONS.includes(section));
}
