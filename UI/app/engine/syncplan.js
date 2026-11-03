// Which projects (or folders) to send, fetch or drop so this device and the cloud end up the same. Pure, so it is checked without a browser.
// `local` items carry { id, dirty, syncedAt, changedAt } (changedAt: when they last changed here, whatever the change);
// `cloud` rows are { id, updated_at } where updated_at is the server's clock.

export function mergePlan(local, cloud) {
  const plan = { pull: [], push: [], dropLocal: [], conflict: [] };
  const here = new Map(local.map((item) => [item.id, item]));
  const there = new Map(cloud.map((row) => [row.id, row]));
  for (const row of cloud) {
    const item = here.get(row.id);
    if (!item) { plan.pull.push(row.id); continue; }
    const cloudChanged = item.syncedAt !== row.updated_at;
    if (item.dirty && !cloudChanged) plan.push.push(item.id);
    else if (!item.dirty && cloudChanged) plan.pull.push(row.id);
    // Changed in both places since they last agreed: resolved with both copies in hand (see resolveConflict).
    else if (item.dirty && cloudChanged) plan.conflict.push(row.id);
  }
  for (const item of local) {
    if (there.has(item.id)) continue;
    // Seen in the cloud before and untouched since: it was deleted on another device. Anything else was never sent, or was edited here.
    if (item.syncedAt && !item.dirty) plan.dropLocal.push(item.id);
    else plan.push.push(item.id);
  }
  return plan;
}

/**
 * Two copies of one project that both changed. The later change wins as a whole, except each video's cloud status ({ uploaded },
 * { removed }, { declined }, { tooBig }, each with `at`): that is decided per video, newest first, because it records what happened
 * to a stored file whichever device made the other edit. Returns { project, winner: 'local' | 'cloud', changed } where `changed` says
 * the result differs from the cloud copy and must be sent.
 */
export function resolveConflict(local, cloudProject, cloudUpdatedAt) {
  const winner = Date.parse(local.changedAt ?? local.updated ?? 0) >= Date.parse(cloudUpdatedAt) ? 'local' : 'cloud';
  const base = structuredClone(winner === 'local' ? local : cloudProject);
  const other = winner === 'local' ? cloudProject : local;
  const newer = (a, b) => (!a ? b : !b ? a : Date.parse(b.at ?? 0) > Date.parse(a.at ?? 0) ? b : a);
  for (const media of base.media ?? []) {
    const twin = (other.media ?? []).find((m) => m.id === media.id);
    const cloud = newer(media.cloud, twin?.cloud);
    if (cloud) media.cloud = cloud;
  }
  const cloudOf = (project) => JSON.stringify((project.media ?? []).map((m) => [m.id, m.cloud ?? null]));
  return { project: base, winner, changed: winner === 'local' || cloudOf(base) !== cloudOf(cloudProject) };
}
