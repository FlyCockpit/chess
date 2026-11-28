/** All non-null lifecycle markers refuse authority, including malformed projections. */
export function isAccountDeletionPending(user: { deletionRequestedAt?: unknown }): boolean {
  return user.deletionRequestedAt != null;
}
