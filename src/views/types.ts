import type { Workspace } from "../../shared/types";
import type { ViewName } from "../components/Shell";

export type RunMutation = (
  path: string,
  method: "POST" | "PATCH",
  body?: unknown,
) => Promise<void>;

export type ViewProps = {
  workspace: Workspace;
  runMutation: RunMutation;
  navigate: (view: ViewName) => void;
  busy: boolean;
};

