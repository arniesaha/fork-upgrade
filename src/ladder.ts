export type LadderResolution = { base: string; ladder: string[] };

export function filterAndOrderTags(
  tags: string[],
  params: { base: string; target: string; prereleasePattern: string },
): string[] {
  const { base, target, prereleasePattern } = params;
  const baseIdx = tags.indexOf(base);
  const targetIdx = tags.indexOf(target);
  if (targetIdx === -1) throw new Error(`target tag '${target}' not found among upstream tags`);
  if (baseIdx === -1) throw new Error(`base tag '${base}' not found among upstream tags`);
  if (targetIdx <= baseIdx) throw new Error(`target tag '${target}' is not ahead of base '${base}'`);
  const prerelease = new RegExp(prereleasePattern, "i");
  const ladder: string[] = [];
  for (let i = baseIdx + 1; i <= targetIdx; i++) {
    const t = tags[i];
    // Drop intermediate pre-releases; always keep the explicitly-requested target.
    if (i < targetIdx && prerelease.test(t)) continue;
    ladder.push(t);
  }
  return ladder;
}
