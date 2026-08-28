import { useEffect, useState } from "react";
import type { AuditEvent, AuditPage } from "../../shared/types";

const PAGE_HISTORY_LIMIT = 6;

/**
 * Loads the recent history for one page.
 *
 * Results are kept alongside the page they belong to, so a refetch triggered by an
 * autosave leaves the list in place instead of collapsing the section on every
 * keystroke pause, while switching pages still hides the previous page's history.
 *
 * A failed lookup stays silent: the history is context, and an error banner over it
 * would sit above editing controls that still work perfectly well.
 *
 * The load runs even while the section is folded, because the same events name whoever
 * else touched this page in the conflict bar.
 */
export function usePageHistory(
  pageId: string,
  revision: number,
  load: (options: { entityId?: string; limit?: number }) => Promise<AuditPage>,
): AuditEvent[] | null {
  const [loaded, setLoaded] = useState<{ pageId: string; events: AuditEvent[] } | null>(null);

  useEffect(() => {
    let alive = true;
    load({ entityId: pageId, limit: PAGE_HISTORY_LIMIT })
      .then((page) => {
        if (alive) setLoaded({ pageId, events: page.events });
      })
      .catch(() => {
        if (alive) setLoaded({ pageId, events: [] });
      });
    return () => {
      alive = false;
    };
  }, [pageId, load, revision]);

  return loaded?.pageId === pageId ? loaded.events : null;
}
