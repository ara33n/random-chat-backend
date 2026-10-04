export const BAN_RESET_MS = 30 * 24 * 60 * 60 * 1000;
export const BAN_DURATIONS_MS = [10 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

export function nextBanPolicy(lastBan, now = Date.now()) {
  const lastCreated = new Date(lastBan?.createdAt || 0).getTime();
  const historyActive = Number.isFinite(lastCreated) && lastCreated > 0 && now - lastCreated < BAN_RESET_MS;
  const previousLevel = historyActive ? Math.max(1, Math.min(3, Number(lastBan?.banLevel) || 1)) : 0;
  const banLevel = Math.min(3, previousLevel + 1);
  return {
    banLevel,
    durationMs: BAN_DURATIONS_MS[banLevel - 1],
    nextDurationMs: BAN_DURATIONS_MS[Math.min(2, banLevel)],
    escalationResetAt: new Date(now + BAN_RESET_MS),
  };
}
