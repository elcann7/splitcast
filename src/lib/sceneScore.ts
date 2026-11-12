import type { Appearance, ShotSize } from "../api";

/**
 * How useful a scene is likely to be in an edit, 0..1. A scene is good when the character is clearly the
 * subject (large in frame, recognised with confidence, alone) and it lasts long enough to use.
 * Everything here comes from what the analysis already stores for each scene.
 */
const SIZE: Record<ShotSize, number> = { closeup: 1, medium: 0.8, wide: 0.35 };

export function sceneScore(a: Appearance): number {
  const dur = a.end - a.start;
  const crowd = a.solo ? 1 : Math.max(0, 1 - (a.peopleCount - 1) * 0.25);
  const view = 0.4 * a.coverage + 0.25 * a.confidence + 0.2 * (SIZE[a.shotSize] ?? 0.6) + 0.15 * crowd;
  const length = dur < 1.2 ? 0.3 : Math.min(1, dur / 4); // flashes are rarely usable, 4 s+ counts as full length
  return view * length;
}

/** Ids of the best `fraction` (0..1) of the scenes, by score. Always at least one when the list is not empty. */
export function bestScenes(list: readonly Appearance[], fraction: number): string[] {
  const n = Math.max(1, Math.round(list.length * fraction));
  return [...list]
    .sort((x, y) => sceneScore(y) - sceneScore(x))
    .slice(0, n)
    .map((a) => a.id);
}
