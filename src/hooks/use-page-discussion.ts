import { useEffect, useState } from "react";
import type { DiscussionThread } from "../../shared/types";

/**
 * Loads the conversation on one page.
 *
 * Kept beside the page it belongs to for the same reason the history is: a refetch triggered
 * by an autosave should leave the threads in place rather than blanking them mid-read, while
 * switching pages must never show the previous page's conversation for a frame.
 *
 * `reload` is what a post calls once the write has landed, so the list reflects the server's
 * answer rather than a guess assembled on the client.
 */
export function usePageDiscussion(
  pageId: string,
  revision: number,
  load: (pageId: string) => Promise<{ threads: DiscussionThread[] }>,
): { threads: DiscussionThread[] | null; failed: boolean; reload: () => Promise<void> } {
  const [loaded, setLoaded] = useState<{ pageId: string; threads: DiscussionThread[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and reloads are triggers, not inputs: one refetches after an autosave, the other after a post lands, and neither is read inside
  useEffect(() => {
    let alive = true;
    load(pageId)
      .then((result) => {
        if (alive) {
          setLoaded({ pageId, threads: result.threads });
          setFailed(null);
        }
      })
      /*
       * A conversation that could not be fetched is not an empty one.
       *
       * Drawing nothing beside a badge saying three things are unread says the messages are
       * gone, and marking them read on the strength of that would lose them for good.
       */
      .catch(() => {
        if (alive) setFailed(pageId);
      });
    return () => {
      alive = false;
    };
  }, [pageId, load, revision, reloads]);

  return {
    threads: loaded?.pageId === pageId ? loaded.threads : null,
    failed: failed === pageId,
    reload: async () => {
      setReloads((count) => count + 1);
    },
  };
}
