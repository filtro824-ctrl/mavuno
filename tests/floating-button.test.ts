import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFloatingPosition,
  floatingTuckOffset,
  nearestFloatingSide,
} from '../src/client/floating-button-utils.js';

test('clamps the floating button inside the visible viewport', () => {
  assert.deepEqual(clampFloatingPosition(-20, -40, 360, 800), { left: 0, top: 0 });
  assert.deepEqual(clampFloatingPosition(500, 900, 360, 800), { left: 308, top: 748 });
  assert.deepEqual(clampFloatingPosition(100, 100, 40, 40), { left: 0, top: 0 });
});

test('snaps to whichever lateral edge is nearest after a drag', () => {
  assert.equal(nearestFloatingSide(20, 360), 'left');
  assert.equal(nearestFloatingSide(140, 360), 'left');
  assert.equal(nearestFloatingSide(180, 360), 'right');
  assert.equal(nearestFloatingSide(320, 360), 'right');
});

test('leaves a small visible handle when tucked against either edge', () => {
  assert.equal(floatingTuckOffset('left'), -40);
  assert.equal(floatingTuckOffset('right'), 40);
});
