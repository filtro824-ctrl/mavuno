export interface InvitationState {
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
  maxUses: number | null;
  useCount: number;
}

export function invitationIsValid(invitation: InvitationState, now = new Date()): boolean {
  if (invitation.revokedAt) return false;
  if (invitation.expiresAt && new Date(invitation.expiresAt).getTime() <= now.getTime()) return false;
  if (invitation.maxUses !== null && invitation.useCount >= invitation.maxUses) return false;
  return true;
}

export function communityRulesAccepted(rules: string | null | undefined, accepted: boolean): boolean {
  return !rules?.trim() || accepted;
}

export function hasPendingJoinRequest(requests: Array<{ status: string }>): boolean {
  return requests.some((request) => request.status === 'pending');
}

export const JOIN_REQUEST_REJECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export function isWithinJoinRequestCooldown(decidedAt: Date | string | null, now = new Date()): boolean {
  if (!decidedAt) return false;
  const timestamp = new Date(decidedAt).getTime();
  return Number.isFinite(timestamp) && timestamp > now.getTime() - JOIN_REQUEST_REJECTION_COOLDOWN_MS && timestamp <= now.getTime();
}
