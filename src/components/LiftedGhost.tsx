import type { Lift } from "../hooks/use-pointer-drag";

/**
 * What the pointer actually holds while a card is carried, drawn over the board it is
 * crossing. The card itself stays out of the flow for as long as the ghost is up.
 */
export function LiftedGhost({
  cardClass,
  labelClass,
  lift,
  title,
}: {
  cardClass: string;
  labelClass: string;
  lift: Lift;
  title: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`${cardClass} lifted`}
      style={{
        left: lift.left,
        top: lift.top,
        width: lift.width,
        height: lift.height,
        transform: `translate(${lift.dx}px, ${lift.dy}px)`,
      }}
    >
      <span className={labelClass}>
        <strong>{title}</strong>
      </span>
    </div>
  );
}
