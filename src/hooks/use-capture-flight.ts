import { type RefObject, useEffect, useRef, useState } from "react";
import type { PageStatus } from "../../shared/types";

export type CaptureFlight = {
  id: number;
  title: string;
  status: PageStatus;
  from: { x: number; y: number; width: number };
  to: { x: number; y: number };
};

export type CaptureFlightState = {
  /** The chip currently in the air, or null between captures. */
  flight: CaptureFlight | null;
  /** Where the rendered chip must be mounted so the animation can measure it. */
  flightRef: RefObject<HTMLDivElement | null>;
  /** The column a capture just landed in, so it can glow for a moment. */
  landed: PageStatus | null;
  spawnFlight: (input: { title: string; status: PageStatus }) => void;
};

/**
 * The capture animation: a chip that flies from the capture box to the column the new page
 * will appear in, so the eye is told where the work went. Under reduced motion the flight is
 * skipped and only the landing glow remains.
 */
export function useCaptureFlight(shellRef: RefObject<HTMLDivElement | null>): CaptureFlightState {
  const [flight, setFlight] = useState<CaptureFlight | null>(null);
  const [landed, setLanded] = useState<PageStatus | null>(null);
  const flightRef = useRef<HTMLDivElement>(null);

  const spawnFlight = (input: { title: string; status: PageStatus }) => {
    const shell = shellRef.current;
    if (!shell) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setLanded(input.status);
      return;
    }
    const home = shell.querySelector(".workspace-capture");
    const target =
      input.status === "backlog"
        ? shell.querySelector(".library-trigger")
        : shell.querySelector(`.column-${input.status}`);
    if (!home || !target) {
      setLanded(input.status);
      return;
    }
    const from = home.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    setFlight({
      id: Date.now(),
      title: input.title,
      status: input.status,
      from: { x: from.left, y: from.top, width: Math.min(from.width, 280) },
      to: { x: to.left + to.width / 2, y: to.top + Math.min(to.height / 2, 40) },
    });
  };

  useEffect(() => {
    if (!flight) return;
    const node = flightRef.current;
    if (!node || typeof node.animate !== "function") {
      setFlight(null);
      setLanded(flight.status);
      return;
    }
    const chip = node.getBoundingClientRect();
    const dx = flight.to.x - (chip.left + chip.width / 2);
    const dy = flight.to.y - (chip.top + chip.height / 2);
    const animation = node.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.3 },
      ],
      { duration: 480, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
    const finish = () => {
      setFlight(null);
      setLanded(flight.status);
    };
    animation.addEventListener("finish", finish);
    return () => {
      animation.removeEventListener("finish", finish);
      animation.cancel();
    };
  }, [flight]);

  useEffect(() => {
    if (!landed) return;
    const timeout = window.setTimeout(() => setLanded(null), 700);
    return () => window.clearTimeout(timeout);
  }, [landed]);

  return { flight, flightRef, landed, spawnFlight };
}
