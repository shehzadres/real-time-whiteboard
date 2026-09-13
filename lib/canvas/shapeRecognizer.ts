// Phase 8: AI Shape Recognition.
//
// Heuristic, geometry-only classifier -- no ML model, no network call, no paid API.
// Runs synchronously on the finished point path of a pen stroke (at mouseup, not
// live during the stroke) and either returns a clean shape to substitute for the
// raw freehand object, or `null` if the stroke doesn't confidently match anything
// (in which case the caller should leave it as freehand -- never force a bad match).
//
// This module has no React/Konva/DOM dependency on purpose: it's pure input (flat
// [x0,y0,x1,y1,...] point array) -> output (a plain shape descriptor), so it can be
// unit-tested with plain synthetic point paths (see scripts/test-shape-recognizer.mjs)
// without a browser.

export type RecognizedShape =
  | { type: 'rectangle'; x: number; y: number; width: number; height: number }
  | { type: 'circle'; x: number; y: number; radiusX: number; radiusY: number }
  | { type: 'triangle'; x: number; y: number; points: number[] }
  | { type: 'arrow'; points: number[] };

interface Pt {
  x: number;
  y: number;
}

// --- Tunable thresholds -----------------------------------------------------
// Every threshold here was picked by testing against synthetic rough strokes
// (see scripts/test-shape-recognizer.mjs) rather than guessed in the abstract.
// If recognition feels too eager or too reluctant in practice, these are the
// knobs to adjust -- nothing else in this file should need to change.
const MIN_POINTS = 3;
const MIN_BBOX_DIAGONAL = 12; // px -- strokes smaller than this are probably an
// accidental click-drag, not an intentional shape; leave them as freehand.
const CLOSED_GAP_RATIO = 0.28; // start/end within this fraction of the bbox
// diagonal counts as "the user closed the loop".
const CIRCLE_CIRCULARITY_MIN = 0.75; // isoperimetric quotient (4*pi*area /
// perimeter^2); 1.0 is a perfect circle, a square is ~0.785, a triangle is
// ~0.60. Only used as a *fallback* when corner detection below doesn't find a
// clean 3- or 4-corner polygon, so it doesn't need to reject squares itself.
const CORNER_EPSILON_RATIO = 0.06; // Ramer-Douglas-Peucker epsilon, as a
// fraction of the bbox diagonal, used to find corners in non-round closed shapes.
const CORNER_DEDUPE_RATIO = 0.05; // merge RDP output points closer than this
// fraction of the diagonal (jitter near a real corner shouldn't count twice).
const SMOOTH_WINDOW = 3; // simple moving-average window applied before corner
// detection, to absorb hand-tremor jitter without erasing real corners.
const OPEN_MIN_SPAN_RATIO = 0.5; // an open stroke's start-to-end distance must
// be at least this fraction of its bbox diagonal to be considered "reaching
// somewhere" rather than a curl that happens to end near its own bbox extent.
const OPEN_STRAIGHTNESS_MAX = 0.12; // max perpendicular deviation from the
// straight start->end chord, as a fraction of that chord's length.

function toPoints(flat: number[]): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  return pts;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bbox(pts: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
  const projX = a.x + t * dx, projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Ramer-Douglas-Peucker path simplification. Used here on closed loops too
// (split at the point farthest from the start, recurse both halves) -- a
// standard, if approximate, way to find polygon corners without a dedicated
// convex-hull step, which is good enough for a heuristic classifier like this.
function rdp(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length < 3) return pts;
  const start = pts[0], end = pts[pts.length - 1];
  let maxDist = 0, index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpendicularDistance(pts[i], start, end);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist > epsilon) {
    const left = rdp(pts.slice(0, index + 1), epsilon);
    const right = rdp(pts.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

function dedupeClose(pts: Pt[], threshold: number): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length === 0 || dist(out[out.length - 1], p) > threshold) out.push(p);
  }
  return out;
}

// Simple centered moving-average smoothing -- absorbs hand-tremor jitter
// before corner detection without needing a real signal-processing dependency.
function smooth(pts: Pt[], window: number): Pt[] {
  if (window < 2 || pts.length <= window) return pts;
  const half = Math.floor(window / 2);
  return pts.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(pts.length - 1, i + half);
    let sx = 0, sy = 0;
    for (let j = start; j <= end; j++) { sx += pts[j].x; sy += pts[j].y; }
    const n = end - start + 1;
    return { x: sx / n, y: sy / n };
  });
}

function shoelaceArea(pts: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function pathPerimeter(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  len += dist(pts[pts.length - 1], pts[0]); // close the loop
  return len;
}

function classifyClosed(pts: Pt[], box: ReturnType<typeof bbox>, diag: number): RecognizedShape | null {
  // Corner detection is the primary signal (a specific, low-false-positive
  // test): find corners on a jitter-smoothed copy of the path, and if it
  // resolves cleanly to a triangle or rectangle, trust that over roundness.
  const smoothed = smooth(pts, SMOOTH_WINDOW);
  const simplified = dedupeClose(rdp(smoothed, diag * CORNER_EPSILON_RATIO), diag * CORNER_DEDUPE_RATIO);
  const closesLoop = simplified.length > 1
    && dist(simplified[0], simplified[simplified.length - 1]) < diag * 0.15;
  const cornerCount = simplified.length - (closesLoop ? 1 : 0);

  if (cornerCount === 3) {
    return {
      type: 'triangle', x: box.minX, y: box.minY,
      points: [box.width / 2, 0, box.width, box.height, 0, box.height],
    };
  }
  if (cornerCount === 4) {
    return { type: 'rectangle', x: box.minX, y: box.minY, width: box.width, height: box.height };
  }

  // No clean small-corner-count polygon -- fall back to a circularity check
  // (isoperimetric quotient: 4*pi*area / perimeter^2, 1.0 for a perfect
  // circle) to catch circles and moderately elongated ellipses.
  const area = shoelaceArea(pts);
  const perimeter = pathPerimeter(pts);
  const circularity = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
  if (circularity > CIRCLE_CIRCULARITY_MIN) {
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    return { type: 'circle', x: cx, y: cy, radiusX: box.width / 2, radiusY: box.height / 2 };
  }

  return null;
}

function classifyOpen(pts: Pt[], first: Pt, last: Pt, diag: number): RecognizedShape | null {
  const span = dist(first, last);
  if (span < diag * OPEN_MIN_SPAN_RATIO) return null;

  let maxDev = 0;
  for (const p of pts) {
    const d = perpendicularDistance(p, first, last);
    if (d > maxDev) maxDev = d;
  }
  const straightness = span > 0 ? maxDev / span : 1;
  if (straightness > OPEN_STRAIGHTNESS_MAX) return null;

  // A deliberate straight open stroke on a whiteboard is overwhelmingly used to
  // point at or connect something, so it snaps to an arrow rather than a plain
  // line -- the dedicated Line tool remains available for an explicit straight
  // line. See PROJECT_HANDOFF.md Phase 8 notes for the reasoning.
  return { type: 'arrow', points: [first.x, first.y, last.x, last.y] };
}

/**
 * Classify a finished pen stroke's point path. Returns a clean shape descriptor
 * if the stroke confidently matches one, or `null` to leave it as freehand.
 */
export function recognizeShape(flatPoints: number[]): RecognizedShape | null {
  const pts = toPoints(flatPoints);
  if (pts.length < MIN_POINTS) return null;

  const box = bbox(pts);
  const diag = Math.hypot(box.width, box.height);
  if (diag < MIN_BBOX_DIAGONAL) return null;

  const first = pts[0], last = pts[pts.length - 1];
  const closed = dist(first, last) < diag * CLOSED_GAP_RATIO;

  return closed ? classifyClosed(pts, box, diag) : classifyOpen(pts, first, last, diag);
}
