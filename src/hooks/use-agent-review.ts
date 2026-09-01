import { useCallback, useEffect, useState } from "react";
import type { AgentReview } from "../../shared/types";
import { agentReview as loadAgentReview, markAgentReviewSeen } from "../api/client";

/**
 * The agent review and the boundary it advances.
 *
 * Deliberately not the away cursor: that one advances by merely having the board on
 * screen, and delegated work consumed by standing near it would never be read. This
 * boundary moves only through `markReviewed`, which the board calls when the person
 * closes the review - looking at it is the act that counts.
 *
 * A review longer than the server's cap advances only to the last change actually
 * shown, so nothing is ever marked reviewed unseen; the rest greets the reader when
 * they open it again.
 */
export function useAgentReview(
  projectId: string | undefined,
  revision: number,
): { review: AgentReview | null; markReviewed: () => void; reload: () => void } {
  const [review, setReview] = useState<AgentReview | null>(null);

  const load = useCallback(() => {
    if (!projectId) return () => {};
    let alive = true;
    loadAgentReview()
      .then((value) => {
        if (alive) setReview(value);
      })
      .catch(() => {
        // The board works without its review; the next reload asks again.
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // The previous review stays up while a reload is in flight, so the trigger's badge
  // settles rather than blinking out on every board refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger that re-asks after each board reload; the load itself reads nothing from it
  useEffect(() => load(), [load, revision]);

  const markReviewed = useCallback(() => {
    if (!review) return;
    const shownEverything = review.events.length >= review.total;
    const boundary = shownEverything ? undefined : review.events[review.events.length - 1]?.sequence;
    markAgentReviewSeen(boundary)
      .then(() => load())
      .catch(() => {
        // A missed advance only means the same work asks to be reviewed again.
      });
  }, [load, review]);

  // Reloading without advancing the boundary, for a change that is not a review - a
  // revoked credential should disappear from the rail without marking anything looked at.
  const reload = useCallback(() => {
    load();
  }, [load]);

  return { review, markReviewed, reload };
}
