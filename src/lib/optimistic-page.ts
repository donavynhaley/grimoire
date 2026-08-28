import type { BoardWorkspace, PageStatus } from "../../shared/types";

/**
 * The board as it will look once the server agrees, applied ahead of the round trip.
 *
 * Only a drag needs this - a tile that waited for the network would hang mid-air - and the
 * caller puts the previous board back if the server refuses for any reason but a content
 * conflict, where the reload is already on its way.
 */
export function applyOptimisticPageUpdate(
  board: BoardWorkspace,
  id: string,
  input: Record<string, unknown>,
): BoardWorkspace {
  const current = board.pages.find((page) => page.id === id);
  if (!current) return board;
  // The github reference travels as pasted text and only the server can read it into a
  // link, so the optimistic page keeps what it had until the parsed truth arrives.
  const { github: _github, ...safeInput } = input;
  input = safeInput;
  const targetStatus = (input.status as PageStatus | undefined) ?? current.status;
  const targetPosition = typeof input.position === "number" ? input.position : current.position;
  const completedAt =
    targetStatus === "done"
      ? current.status === "done"
        ? current.completedAt
        : new Date().toISOString()
      : null;
  const assigneeId =
    input.assigneeId === undefined ? current.assigneeId : (input.assigneeId as string | null);
  const assignee = board.members.find((member) => member.id === assigneeId);
  const remaining = board.pages.filter((page) => page.id !== id);
  const targetPages = remaining
    .filter((page) => page.status === targetStatus)
    .sort((a, b) => a.position - b.position);
  const insertAt = Math.max(0, Math.min(targetPosition, targetPages.length));
  targetPages.splice(insertAt, 0, {
    ...current,
    ...input,
    status: targetStatus,
    completedAt,
    assigneeId,
    assigneeName: assignee?.name ?? null,
  });
  const reordered = targetPages.map((page, position) => ({ ...page, position }));
  return {
    ...board,
    pages: [...remaining.filter((page) => page.status !== targetStatus), ...reordered],
  };
}
