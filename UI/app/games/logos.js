// Outlines for "Draw the logo": strokes of [x, y] points in a 0–1 box. Only Relio's own marks and simple shapes,
// never another company's logo.

const circle = (cx, cy, r, steps = 32) => Array.from({ length: steps + 1 }, (_, i) => {
  const a = (i / steps) * Math.PI * 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
/** Part of a circle from angle `from` to `to` (radians, clockwise on screen). */
const arc = (cx, cy, r, from, to, steps = 20) => Array.from({ length: steps + 1 }, (_, i) => {
  const a = from + ((to - from) * i) / steps;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const star = () => Array.from({ length: 11 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.2 : 0.48;
  return [0.5 + r * Math.cos(a), 0.52 + r * Math.sin(a)];
});
const heart = () => Array.from({ length: 41 }, (_, i) => {
  const t = (i / 40) * Math.PI * 2;
  const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return [0.5 + x / 36, 0.45 - y / 36];
});

export const LOGOS = [
  { id: 'relio', name: 'Relio Clips', strokes: [[[0.5, 0.08], [0.94, 0.88], [0.06, 0.88], [0.5, 0.08]]] },
  // Prism: a triangle with a beam of light going in on the left and out on the right.
  { id: 'prism', name: 'Prism', strokes: [[[0.5, 0.15], [0.85, 0.82], [0.15, 0.82], [0.5, 0.15]], [[0.02, 0.6], [0.36, 0.5]], [[0.66, 0.5], [0.98, 0.42]]] },
  // pampai: a round "p" (a ring with a stem down the left).
  { id: 'pampai', name: 'pampai', strokes: [circle(0.55, 0.36, 0.26), [[0.29, 0.36], [0.29, 0.95]]] },
  { id: 'star', name: 'Star', strokes: [star()] },
  { id: 'heart', name: 'Heart', strokes: [heart()] },
  { id: 'house', name: 'House', strokes: [[[0.15, 0.45], [0.5, 0.1], [0.85, 0.45]], [[0.22, 0.4], [0.22, 0.9], [0.78, 0.9], [0.78, 0.4]], [[0.42, 0.9], [0.42, 0.65], [0.58, 0.65], [0.58, 0.9]]] },
  { id: 'bolt', name: 'Lightning bolt', strokes: [[[0.6, 0.05], [0.25, 0.55], [0.5, 0.55], [0.38, 0.95], [0.78, 0.4], [0.52, 0.4], [0.6, 0.05]]] },
  { id: 'circle-square', name: 'Circle in a square', strokes: [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9], [0.1, 0.1]], circle(0.5, 0.5, 0.3)] },
  // Relio's play button: a rounded square with a triangle inside.
  { id: 'play', name: 'Play button', strokes: [[[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8], [0.1, 0.2]], [[0.42, 0.35], [0.64, 0.5], [0.42, 0.65], [0.42, 0.35]]] },
  // Outer edge round the left, then the inner edge back: two arcs meeting at the tips.
  { id: 'moon', name: 'Crescent moon', strokes: [[...arc(0.5, 0.5, 0.4, 1.1, 2 * Math.PI - 1.1), ...arc(0.78, 0.5, 0.37, 4.439, 1.844)]] },
  { id: 'sun', name: 'Sun', strokes: [circle(0.5, 0.5, 0.2), ...Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return [[0.5 + 0.28 * Math.cos(a), 0.5 + 0.28 * Math.sin(a)], [0.5 + 0.44 * Math.cos(a), 0.5 + 0.44 * Math.sin(a)]];
  })] },
  { id: 'cloud', name: 'Cloud', strokes: [[...arc(0.3, 0.58, 0.16, Math.PI / 2, Math.PI * 1.5), ...arc(0.48, 0.42, 0.2, Math.PI * 1.1, Math.PI * 1.9),
    ...arc(0.7, 0.55, 0.18, Math.PI * 1.4, Math.PI * 2.5), [0.3, 0.74]]] },
  { id: 'diamond', name: 'Diamond', strokes: [[[0.2, 0.35], [0.35, 0.15], [0.65, 0.15], [0.8, 0.35], [0.5, 0.9], [0.2, 0.35]], [[0.2, 0.35], [0.8, 0.35]]] },
  { id: 'arrow', name: 'Arrow', strokes: [[[0.1, 0.5], [0.85, 0.5]], [[0.6, 0.25], [0.9, 0.5], [0.6, 0.75]]] },
  { id: 'envelope', name: 'Envelope', strokes: [[[0.1, 0.25], [0.9, 0.25], [0.9, 0.75], [0.1, 0.75], [0.1, 0.25]], [[0.1, 0.25], [0.5, 0.55], [0.9, 0.25]]] },
  { id: 'tree', name: 'Tree', strokes: [[[0.5, 0.08], [0.82, 0.45], [0.66, 0.45], [0.86, 0.72], [0.14, 0.72], [0.34, 0.45], [0.18, 0.45], [0.5, 0.08]], [[0.44, 0.72], [0.44, 0.92], [0.56, 0.92], [0.56, 0.72]]] },
  { id: 'fish', name: 'Fish', strokes: [[[0.15, 0.5], [0.35, 0.3], [0.6, 0.28], [0.78, 0.5], [0.6, 0.72], [0.35, 0.7], [0.15, 0.5]], [[0.78, 0.5], [0.95, 0.32], [0.95, 0.68], [0.78, 0.5]]] },
  { id: 'crown', name: 'Crown', strokes: [[[0.12, 0.78], [0.12, 0.3], [0.32, 0.55], [0.5, 0.22], [0.68, 0.55], [0.88, 0.3], [0.88, 0.78], [0.12, 0.78]]] },
  { id: 'umbrella', name: 'Umbrella', strokes: [[...arc(0.5, 0.5, 0.4, Math.PI, Math.PI * 2), [0.1, 0.5]], [[0.5, 0.5], [0.5, 0.85], [0.42, 0.9], [0.36, 0.84]]] },
  { id: 'smile', name: 'Smiley', strokes: [circle(0.5, 0.5, 0.42), arc(0.5, 0.5, 0.24, 0.5, Math.PI - 0.5), [[0.36, 0.36], [0.36, 0.44]], [[0.64, 0.36], [0.64, 0.44]]] },
];
