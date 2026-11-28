export type AccountDeletionSuppression = {
  version: 2;
  subjectHash: string;
  requestedAt: string;
  expiresAt: string;
  sequence: number;
  previousDigest: string;
  digest: string;
};
export type AccountDeletionRegister = {
  head: string;
  records: AccountDeletionSuppression[];
};
export declare const EMPTY_REGISTER_HEAD: string;
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
export function readAccountDeletionRegister(
  directory: string | undefined,
): Promise<AccountDeletionRegister>;
export function assertAccountDeletionRegisterHead(
  snapshot: AccountDeletionRegister,
  expectedHead: string,
): void;
export function accountDeletionSuppressionSql(
  records: AccountDeletionSuppression[],
  schema?: string,
): string;
