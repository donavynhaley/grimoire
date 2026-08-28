import { eventsQuerySchema } from "../schemas";
import type { AppContext } from "./context";
import type { Route } from "./route";

/** The one long-lived route: a browser's event stream, and the presence derived from it. */
export function eventRoutes(app: AppContext): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/events",
      handler: (context) => {
        const clientId = eventsQuerySchema.parse(Object.fromEntries(context.url.searchParams)).client ?? "";
        app.openEventStream(context, clientId);
      },
    },
  ];
}
