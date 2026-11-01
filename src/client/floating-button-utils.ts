export const FLOATING_BUTTON_SIZE = 52;
export const FLOATING_BUTTON_PEEK = 12;

export type FloatingSide = 'left' | 'right';

export function clampFloatingPosition(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(left, Math.max(0, viewportWidth - FLOATING_BUTTON_SIZE))),
    top: Math.max(0, Math.min(top, Math.max(0, viewportHeight - FLOATING_BUTTON_SIZE))),
  };
}

export function nearestFloatingSide(left: number, viewportWidth: number): FloatingSide {
  return left + FLOATING_BUTTON_SIZE / 2 < viewportWidth / 2 ? 'left' : 'right';
}

export function floatingTuckOffset(side: FloatingSide): number {
  const hiddenWidth = FLOATING_BUTTON_SIZE - FLOATING_BUTTON_PEEK;
  return side === 'left' ? -hiddenWidth : hiddenWidth;
}
