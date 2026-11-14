// Outlines for "Draw the logo": strokes of [x, y] points in a 0–1 box. Only Relio's own marks and simple shapes,
// never another company's logo.

const circle = (cx, cy, r, steps = 32) => Array.from({ length: steps + 1 }, (_, i) => {
  const a = (i / steps) * Math.PI * 2;
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
];
