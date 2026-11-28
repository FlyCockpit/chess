export type AccountDeletionSuppression = {
  version: 1;
  subjectHash: string;
  requestedAt: string;
  expiresAt: string;
};
export function accountDeletionSubjectHash(userId: string): string;
export function assertAccountDeletionRegisterAvailable(
  directory: string | undefined,
): Promise<void>;
export function appendAccountDeletionSuppression(input: {
  directory: string | undefined;
  userId: string;
  requestedAt: Date;
  now?: Date;
}): Promise<void>;
export function readAccountDeletionSuppressions(
  directory: string | undefined,
): Promise<AccountDeletionSuppression[]>;
export function accountDeletionSuppressionSql(
  records: AccountDeletionSuppression[],
  schema?: string,
): string;
