// Pure-geometry test harness for lib/canvas/shapeRecognizer.ts.
// Generates synthetic "rough hand-drawn" point paths (with jitter) for each
// target shape plus adversarial/negative cases, runs the classifier, and
// asserts the result. No browser, no server, no Redis/Mongo needed -- run with:
//   npx tsx scripts/test-shape-recognizer.mjs
import { recognizeShape } from '../lib/canvas/shapeRecognizer.ts';

let pass = 0, fail = 0;

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function jitter(pts, amount, rand) {
  return pts.flatMap(([x, y]) => [x + (rand() - 0.5) * amount, y + (rand() - 0.5) * amount]);
}

// Densify a polyline (straight segments between corners) into many points,
// simulating a mouse/touch sampling a hand-drawn stroke at a roughly constant
// speed -- so point density is proportional to segment *length* (arc length),
// not a fixed count per segment (which would over-sample short edges and bias
// the shape statistics in a way real mouse-move sampling wouldn't).
function densifyPolyline(corners, pointsPerPixel = 0.3) {
  const out = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [x1, y1] = corners[i], [x2, y2] = corners[i + 1];
    const segLen = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(2, Math.round(segLen * pointsPerPixel));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  out.push(corners[corners.length - 1]);
  return out;
}

function roughRectangle(x, y, w, h, rand, jitterAmt = 3) {
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  return jitter(densifyPolyline(corners), jitterAmt, rand);
}

function roughTriangle(x, y, w, h, rand, jitterAmt = 3) {
  const corners = [[x + w / 2, y], [x + w, y + h], [x, y + h], [x + w / 2, y]];
  return jitter(densifyPolyline(corners), jitterAmt, rand);
}

function roughCircle(cx, cy, r, rand, jitterAmt = 3, n = 40) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
  }
  return jitter(pts, jitterAmt, rand);
}

function roughStraightStroke(x1, y1, x2, y2, rand, jitterAmt = 3, n = 20) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
  }
  return jitter(pts, jitterAmt, rand);
}

function scribble(rand, n = 60) {
  const pts = [];
  let x = 100, y = 100;
  for (let i = 0; i < n; i++) {
    x += (rand() - 0.5) * 40;
    y += (rand() - 0.5) * 40;
    pts.push(x, y);
  }
  return pts;
}

function check(name, points, expectType, extra) {
  const result = recognizeShape(points);
  const ok = expectType === null ? result === null : result?.type === expectType;
  if (ok) {
    pass++;
    console.log(`  PASS  ${name} -> ${result ? result.type : 'null'}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} -> expected ${expectType}, got ${result ? JSON.stringify(result) : 'null'}`);
  }
  if (extra) extra(result);
}

const rand = seededRandom(42);

console.log('Positive cases (should recognize):');
for (let i = 0; i < 5; i++) {
  check(`rectangle #${i} (200x120, jitter 3px)`, roughRectangle(50, 50, 200, 120, rand), 'rectangle');
}
for (let i = 0; i < 5; i++) {
  check(`triangle #${i} (180x150, jitter 3px)`, roughTriangle(50, 50, 180, 150, rand), 'triangle');
}
for (let i = 0; i < 5; i++) {
  check(`circle #${i} (r=80, jitter 3px)`, roughCircle(150, 150, 80, rand), 'circle');
}
for (let i = 0; i < 5; i++) {
  check(`ellipse #${i} (rx=120,ry=60 via jitter)`, jitter(
    Array.from({ length: 41 }, (_, k) => {
      const t = (k / 40) * Math.PI * 2;
      return [150 + 120 * Math.cos(t), 150 + 60 * Math.sin(t)];
    }), 3, rand
  ), 'circle');
}
for (let i = 0; i < 5; i++) {
  check(`straight stroke #${i} -> arrow`, roughStraightStroke(20, 20, 220, 180, rand), 'arrow');
}

console.log('\nNegative / edge cases (should stay freehand -> null):');
check('random scribble', scribble(rand), null);
check('tiny click-drag (5px)', [[100, 100], [102, 101], [104, 103]].flat(), null);
check('wavy open stroke (sine wave)', (() => {
  const pts = [];
  for (let i = 0; i <= 30; i++) {
    const x = 20 + i * 6;
    const y = 100 + Math.sin(i / 3) * 40;
    pts.push(x, y);
  }
  return pts;
})(), null);
check('5-pointed star (closed, not round, not 3/4 corners)', (() => {
  const pts = [];
  const outerR = 80, innerR = 32, cx = 150, cy = 150;
  for (let i = 0; i <= 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const theta = (i / 10) * Math.PI * 2 - Math.PI / 2;
    pts.push(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
  }
  return jitter(Array.from({ length: pts.length / 2 }, (_, k) => [pts[k * 2], pts[k * 2 + 1]]), 2, rand);
})(), null);

console.log(`\n${pass} passed, ${fail} failed`);

// Separate, non-gating stress test: very heavy jitter (10px on a 250x150
// shape) is a genuinely hard case for a pure-geometry classifier -- reported
// but not asserted, same "flag don't assert" pattern used elsewhere in this
// project (see PROJECT_HANDOFF.md Phase 6/7 known-limitation notes).
console.log('\nStress test (10px jitter on a 250x150 rectangle -- reported, not asserted):');
let stressPass = 0;
for (let i = 0; i < 5; i++) {
  const result = recognizeShape(roughRectangle(30, 30, 250, 150, rand, 10));
  const ok = result?.type === 'rectangle';
  if (ok) stressPass++;
  console.log(`  ${ok ? 'ok  ' : 'miss'}  noisy rectangle #${i} -> ${result ? result.type : 'null'}`);
}
console.log(`  ${stressPass}/5 recognized at this jitter level`);

if (fail > 0) process.exit(1);
