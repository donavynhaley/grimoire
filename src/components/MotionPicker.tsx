import { PAGE_MOTIONS, type PageMotion } from "../lib/page-motion";

type Props = {
  motion: PageMotion;
  onChange: (motion: PageMotion) => void;
};

/**
 * Switches the page editor's entrance while it is open, for whoever is choosing between them.
 *
 * Review scaffolding, not product: it is rendered only when `?motion=` is in the address, so a
 * normal session never sees it and nothing has to be remembered about turning it off. Changing
 * the choice here rewrites the address too, so a comparison can be sent to somebody else.
 */
export function MotionPicker({ motion, onChange }: Props) {
  return (
    <div aria-label="Page entrance" className="motion-picker" role="group">
      {PAGE_MOTIONS.map((candidate) => (
        <button
          aria-pressed={candidate === motion}
          key={candidate}
          onClick={() => onChange(candidate)}
          type="button"
        >
          {candidate}
        </button>
      ))}
    </div>
  );
}
