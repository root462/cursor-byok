type PillBounds = { x: number; y: number; width: number; height: number };

const interpolate = (from: number, to: number, progress: number) => from + (to - from) * progress;
const easeOut = (progress: number) => 1 - (1 - Math.min(1, Math.max(0, progress))) ** 3;

/** Animate the leading and trailing edges separately, rather than translating a rigid box. */
export function createStickyNavigationKeyframes(from: PillBounds, to: PillBounds): Keyframe[] {
  const down = to.y + to.height / 2 >= from.y + from.height / 2;
  const distance = Math.abs(to.y - from.y);
  const lagLimit = 28;
  const pinch = Math.min(8, distance * 0.08);

  return Array.from({ length: 41 }, (_, index) => {
    const time = index / 40;
    // The leading edge moves first; the trailing edge follows with capped slack.
    const head = easeOut(time / 0.72);
    const tail = easeOut((time - 0.16) / 0.84);
    const lag = Math.abs(to.y - from.y) * Math.max(0, head - tail);
    const catchUp = Math.min(1, Math.max(0, lag - lagLimit) / Math.max(distance, 1));
    const trailing = tail + catchUp;
    const topProgress = down ? trailing : head;
    const bottomProgress = down ? head : trailing;
    const top = interpolate(from.y, to.y, topProgress);
    const bottom = interpolate(from.y + from.height, to.y + to.height, bottomProgress);
    const tension = Math.min(1, lag / lagLimit);
    const inset = pinch * tension;

    return {
      offset: time,
      top: `${top}px`,
      left: `${interpolate(from.x, to.x, head) + inset}px`,
      width: `${interpolate(from.width, to.width, head) - inset * 2}px`,
      height: `${Math.max(1, bottom - top)}px`,
      borderRadius: `${12 + tension * 14}px`,
    };
  });
}
