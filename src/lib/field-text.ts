import type { FieldValue, ProjectField } from "../../shared/types";

/** How a field value reads at rest - shared by the editor and the facet panel. */
export function fieldValueText(field: ProjectField, value: FieldValue | undefined): string {
  if (value === undefined) return "—";
  if (field.type === "checkbox") return value ? "yes" : "no";
  return String(value);
}
