import type { SystemUser } from '../types';
import type { ReceiptBeforeProof } from './receiptProtocol';
import { canonicalProofValue } from './syncProtocol';
import {
  KNOWN_PERMISSION_IDS,
  PRODUCT_LIMITS,
  assertDomainProofPayload,
  assertLegacyUserProofPayload,
} from './productSchema';

export const MANAGED_RECOVERY_STATES = [
  'INTENT_DURABLE',
  'AUTH_CREATE_IN_FLIGHT',
  'AUTH_CREATE_FAILED',
  'AUTH_CREATE_AMBIGUOUS',
  'AUTH_CONFIRMED',
  'FIRESTORE_IN_FLIGHT',
  'FIRESTORE_COMMITTED',
  'FIRESTORE_AMBIGUOUS',
  'FIRESTORE_NON_COMMIT_CONFIRMED',
  'AUTH_ROLLBACK_IN_FLIGHT',
  'AUTH_ROLLBACK_CONFIRMED',
  'AUTH_ROLLBACK_FAILED',
  'AUTH_ROLLBACK_AMBIGUOUS',
  'PASSWORD_RESET_IN_FLIGHT',
  'PASSWORD_RESET_CONFIRMED',
  'PASSWORD_RESET_FAILED',
  'PASSWORD_RESET_AMBIGUOUS',
  'JOURNAL_CORRUPT',
  'JOURNAL_MISSING',
] as const;

export type ManagedRecoveryState = typeof MANAGED_RECOVERY_STATES[number];
export type ManagedUserMutationAction = 'create' | 'update' | 'activate' | 'deactivate' | 'password_reset';

// A review disposition preserves the original state, error, identity and payload evidence.
export interface ManagedRecoveryManualReview {
  disposition: 'required' | 'resolved';
  reason: 'HISTORICAL_AUTH_OUTCOME_UNPROVEN' | 'CREATE_AUTH_OWNERSHIP_UNPROVEN';
  sourceState: ManagedRecoveryState;
  evidenceReference?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

export const managedRecoveryReviewDisposition = (record: DurableManagedUserMutation): 'none' | 'required' | 'resolved' =>
  record.manualReview?.disposition ?? 'none';

export const quarantineHistoricalManagedAuth = (record: DurableManagedUserMutation): DurableManagedUserMutation => {
  if (managedRecoveryReviewDisposition(record) !== 'none') return record;
  if (!['AUTH_CREATE_IN_FLIGHT', 'AUTH_CREATE_AMBIGUOUS', 'PASSWORD_RESET_IN_FLIGHT', 'PASSWORD_RESET_AMBIGUOUS'].includes(record.state)) return record;
  return requireManagedRecoveryReview(record, 'HISTORICAL_AUTH_OUTCOME_UNPROVEN');
};

export const requireManagedRecoveryReview = (record: DurableManagedUserMutation, reason: ManagedRecoveryManualReview['reason']): DurableManagedUserMutation =>
  ({ ...record, manualReview: { disposition: 'required', reason, sourceState: record.state } });

export const resolveManagedRecoveryReviewRecord = (record: DurableManagedUserMutation, evidenceReference: string, now: number): DurableManagedUserMutation => {
  if (managedRecoveryReviewDisposition(record) !== 'required') throw new Error('MANAGED_USER_REVIEW_NOT_REQUIRED');
  const reference = evidenceReference.trim();
  if (!reference || new TextEncoder().encode(reference).byteLength > 120) throw new Error('MANAGED_USER_REVIEW_EVIDENCE_REQUIRED');
  const resolvedAt = Math.max(now, record.updatedAt);
  const resolved: DurableManagedUserMutation = { ...record, updatedAt: resolvedAt,
    manualReview: { ...record.manualReview!, disposition: 'resolved', evidenceReference: reference, resolvedBy: record.actorUid, resolvedAt } };
  assertDurableManagedUserMutation(resolved);
  return resolved;
};

export interface ManagedProfileIntent {
  id: string;
  username: string;
  fullName: string;
  role: string;
  permissions: string[];
  createdAt: string;
}

export interface DurableManagedUserMutation {
  version: 2;
  id: string;
  actorUid: string;
  action: ManagedUserMutationAction;
  targetEmail: string;
  targetLocalId: string;
  profile?: ManagedProfileIntent;
  desiredActive?: boolean;
  targetUid?: string;
  before?: ReceiptBeforeProof;
  baselineRequestBytes?: number;
  state: ManagedRecoveryState;
  createdAt: number;
  updatedAt: number;
  lastErrorCode?: string;
  manualReview?: ManagedRecoveryManualReview;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ID = /^[A-Za-z0-9._:-]{1,180}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertText(value: unknown, maximum: number, code: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maximum) throw new Error(code);
}

function assertProfileIntent(value: unknown): asserts value is ManagedProfileIntent {
  if (!isRecord(value)) throw new Error('MANAGED_USER_JOURNAL_PROFILE_INVALID');
  if (Object.keys(value).some(key => ![
    'id', 'username', 'fullName', 'role', 'permissions', 'createdAt',
  ].includes(key))) throw new Error('MANAGED_USER_JOURNAL_PROFILE_FIELD_INVALID');
  assertText(value.id, PRODUCT_LIMITS.documentIdBytes, 'MANAGED_USER_JOURNAL_PROFILE_ID_INVALID');
  assertText(value.username, PRODUCT_LIMITS.indexedTextBytes, 'MANAGED_USER_JOURNAL_PROFILE_EMAIL_INVALID');
  if (!EMAIL.test(value.username.toLowerCase())) throw new Error('MANAGED_USER_JOURNAL_PROFILE_EMAIL_INVALID');
  assertText(value.fullName, PRODUCT_LIMITS.indexedTextBytes, 'MANAGED_USER_JOURNAL_PROFILE_NAME_INVALID');
  assertText(value.role, PRODUCT_LIMITS.indexedTextBytes, 'MANAGED_USER_JOURNAL_PROFILE_ROLE_INVALID');
  assertText(value.createdAt, PRODUCT_LIMITS.isoDateBytes, 'MANAGED_USER_JOURNAL_PROFILE_DATE_INVALID');
  if (!Array.isArray(value.permissions)
    || value.permissions.length === 0
    || value.permissions.length > PRODUCT_LIMITS.permissions
    || new Set(value.permissions).size !== value.permissions.length
    || value.permissions.some(permission => typeof permission !== 'string' || !KNOWN_PERMISSION_IDS.has(permission))) {
    throw new Error('MANAGED_USER_JOURNAL_PROFILE_PERMISSIONS_INVALID');
  }
}

function assertBeforeProof(value: unknown): asserts value is ReceiptBeforeProof {
  if (!isRecord(value)) throw new Error('MANAGED_USER_JOURNAL_BASELINE_INVALID');
  if (value.kind === 'missing' && Object.keys(value).length === 1) return;
  if (value.kind === 'state'
    && Object.keys(value).every(key => ['kind', 'revision', 'mutationId'].includes(key))
    && Object.keys(value).length === 3
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) > 0
    && typeof value.mutationId === 'string'
    && ID.test(value.mutationId)) return;
  if (value.kind === 'legacy'
    && Object.keys(value).length === 2
    && isRecord(value.exactLegacyPayload)) {
    assertLegacyUserProofPayload(value.exactLegacyPayload);
    return;
  }
  throw new Error('MANAGED_USER_JOURNAL_BASELINE_INVALID');
}

export function assertDurableManagedUserMutation(
  value: unknown,
): asserts value is DurableManagedUserMutation {
  if (!isRecord(value) || value.version !== 2) throw new Error('MANAGED_USER_JOURNAL_VERSION_INVALID');
  if (Object.keys(value).some(key => ![
    'version', 'id', 'actorUid', 'action', 'targetEmail', 'targetLocalId', 'profile',
    'desiredActive', 'targetUid', 'before', 'baselineRequestBytes', 'state', 'createdAt',
    'updatedAt', 'lastErrorCode', 'manualReview',
  ].includes(key))) throw new Error('MANAGED_USER_JOURNAL_FIELD_INVALID');
  assertText(value.id, PRODUCT_LIMITS.documentIdBytes, 'MANAGED_USER_JOURNAL_ID_INVALID');
  if (!ID.test(value.id)) throw new Error('MANAGED_USER_JOURNAL_ID_INVALID');
  assertText(value.actorUid, PRODUCT_LIMITS.documentIdBytes, 'MANAGED_USER_JOURNAL_ACTOR_INVALID');
  assertText(value.targetEmail, PRODUCT_LIMITS.indexedTextBytes, 'MANAGED_USER_JOURNAL_EMAIL_INVALID');
  if (!EMAIL.test(value.targetEmail.toLowerCase())) throw new Error('MANAGED_USER_JOURNAL_EMAIL_INVALID');
  assertText(value.targetLocalId, PRODUCT_LIMITS.documentIdBytes, 'MANAGED_USER_JOURNAL_TARGET_INVALID');
  if (!['create', 'update', 'activate', 'deactivate', 'password_reset'].includes(String(value.action))) {
    throw new Error('MANAGED_USER_JOURNAL_ACTION_INVALID');
  }
  if (!MANAGED_RECOVERY_STATES.includes(value.state as ManagedRecoveryState)) {
    throw new Error('MANAGED_USER_JOURNAL_STATE_INVALID');
  }
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0
    || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) {
    throw new Error('MANAGED_USER_JOURNAL_TIME_INVALID');
  }
  if (value.lastErrorCode !== undefined) {
    assertText(value.lastErrorCode, PRODUCT_LIMITS.documentIdBytes, 'MANAGED_USER_JOURNAL_ERROR_INVALID');
  }
  if (value.manualReview !== undefined) {
    const review = value.manualReview;
    if (!isRecord(review) || Object.keys(review).some(key => !['disposition', 'reason', 'sourceState', 'evidenceReference', 'resolvedBy', 'resolvedAt'].includes(key))
      || !['required', 'resolved'].includes(String(review.disposition))
      || !['HISTORICAL_AUTH_OUTCOME_UNPROVEN', 'CREATE_AUTH_OWNERSHIP_UNPROVEN'].includes(String(review.reason))
      || review.sourceState !== value.state
      || !['AUTH_CREATE_IN_FLIGHT', 'AUTH_CREATE_AMBIGUOUS', 'PASSWORD_RESET_IN_FLIGHT', 'PASSWORD_RESET_AMBIGUOUS', 'AUTH_CONFIRMED', 'FIRESTORE_IN_FLIGHT', 'FIRESTORE_AMBIGUOUS', 'AUTH_ROLLBACK_IN_FLIGHT', 'AUTH_ROLLBACK_FAILED', 'AUTH_ROLLBACK_AMBIGUOUS', 'FIRESTORE_NON_COMMIT_CONFIRMED'].includes(String(value.state))
      || !['create', 'password_reset'].includes(String(value.action))) throw new Error('MANAGED_USER_REVIEW_INVALID');
    if (review.disposition === 'resolved') {
      assertText(review.evidenceReference, 120, 'MANAGED_USER_REVIEW_EVIDENCE_REQUIRED');
      if (review.resolvedBy !== value.actorUid || !Number.isSafeInteger(review.resolvedAt)
        || Number(review.resolvedAt) < Number(value.createdAt) || Number(review.resolvedAt) > Number(value.updatedAt)) throw new Error('MANAGED_USER_REVIEW_INVALID');
    } else if (['evidenceReference', 'resolvedBy', 'resolvedAt'].some(key => key in review)) throw new Error('MANAGED_USER_REVIEW_INVALID');
  }
  if (value.targetUid !== undefined) {
    assertText(value.targetUid, PRODUCT_LIMITS.documentIdBytes, 'MANAGED_USER_JOURNAL_UID_INVALID');
  }
  if (value.before !== undefined) assertBeforeProof(value.before);
  if (value.baselineRequestBytes !== undefined
    && (!Number.isSafeInteger(value.baselineRequestBytes) || Number(value.baselineRequestBytes) < 0)) {
    throw new Error('MANAGED_USER_JOURNAL_BASELINE_BYTES_INVALID');
  }
  if (value.action === 'password_reset') {
    if (!value.targetUid || value.profile !== undefined || value.desiredActive !== undefined || value.before !== undefined) {
      throw new Error('MANAGED_USER_JOURNAL_PASSWORD_RESET_SHAPE_INVALID');
    }
  } else {
    assertProfileIntent(value.profile);
    if (typeof value.desiredActive !== 'boolean') throw new Error('MANAGED_USER_JOURNAL_ACTIVE_INVALID');
    if (value.targetUid) {
      assertDomainProofPayload('users', {
        ...value.profile,
        authUid: value.targetUid,
        active: value.desiredActive,
      });
      const createAuthOnlyState = value.action === 'create' && [
        'AUTH_CREATE_IN_FLIGHT',
        'AUTH_CREATE_AMBIGUOUS',
        'AUTH_ROLLBACK_IN_FLIGHT',
        'AUTH_ROLLBACK_CONFIRMED',
        'AUTH_ROLLBACK_FAILED',
        'AUTH_ROLLBACK_AMBIGUOUS',
      ].includes(String(value.state));
      if (!value.before && !createAuthOnlyState) throw new Error('MANAGED_USER_JOURNAL_BASELINE_MISSING');
    }
  }
}

export const managedProfileIntent = (profile: SystemUser): ManagedProfileIntent => ({
  id: profile.id.trim(),
  username: profile.username.trim().toLowerCase(),
  fullName: profile.fullName.trim(),
  role: profile.role.trim(),
  permissions: [...profile.permissions],
  createdAt: profile.createdAt,
});

export const managedCanonicalProfile = (record: DurableManagedUserMutation): SystemUser => {
  if (!record.profile || !record.targetUid || typeof record.desiredActive !== 'boolean') {
    throw new Error('MANAGED_USER_JOURNAL_IDENTITY_INCOMPLETE');
  }
  return {
    ...record.profile,
    authUid: record.targetUid,
    active: record.desiredActive,
  };
};

export const managedIntentEquals = (
  record: DurableManagedUserMutation,
  actorUid: string,
  action: ManagedUserMutationAction,
  profile: ManagedProfileIntent | undefined,
  targetEmail: string,
  desiredActive?: boolean,
): boolean => record.actorUid === actorUid
  && record.action === action
  && record.targetEmail === targetEmail.trim().toLowerCase()
  && record.desiredActive === desiredActive
  && canonicalProofValue(record.profile) === canonicalProofValue(profile);

const TRANSITIONS: Readonly<Record<ManagedRecoveryState, ReadonlySet<ManagedRecoveryState>>> = {
  INTENT_DURABLE: new Set(['AUTH_CREATE_IN_FLIGHT', 'FIRESTORE_IN_FLIGHT', 'PASSWORD_RESET_IN_FLIGHT', 'JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  AUTH_CREATE_IN_FLIGHT: new Set(['INTENT_DURABLE', 'AUTH_CREATE_FAILED', 'AUTH_CREATE_AMBIGUOUS', 'AUTH_CONFIRMED', 'AUTH_ROLLBACK_IN_FLIGHT', 'JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  AUTH_CREATE_FAILED: new Set(['JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  AUTH_CREATE_AMBIGUOUS: new Set(['AUTH_CONFIRMED', 'AUTH_ROLLBACK_IN_FLIGHT', 'JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  AUTH_CONFIRMED: new Set(['FIRESTORE_IN_FLIGHT', 'AUTH_ROLLBACK_IN_FLIGHT', 'JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  FIRESTORE_IN_FLIGHT: new Set(['INTENT_DURABLE', 'AUTH_CONFIRMED', 'FIRESTORE_COMMITTED', 'FIRESTORE_AMBIGUOUS', 'FIRESTORE_NON_COMMIT_CONFIRMED', 'JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  FIRESTORE_COMMITTED: new Set(['JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  FIRESTORE_AMBIGUOUS: new Set(['FIRESTORE_IN_FLIGHT', 'FIRESTORE_COMMITTED', 'JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  FIRESTORE_NON_COMMIT_CONFIRMED: new Set(['INTENT_DURABLE', 'AUTH_ROLLBACK_IN_FLIGHT']),
  AUTH_ROLLBACK_IN_FLIGHT: new Set(['AUTH_ROLLBACK_CONFIRMED', 'AUTH_ROLLBACK_FAILED', 'AUTH_ROLLBACK_AMBIGUOUS']),
  AUTH_ROLLBACK_CONFIRMED: new Set(['JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  AUTH_ROLLBACK_FAILED: new Set(['AUTH_ROLLBACK_IN_FLIGHT']),
  AUTH_ROLLBACK_AMBIGUOUS: new Set(['AUTH_ROLLBACK_IN_FLIGHT']),
  PASSWORD_RESET_IN_FLIGHT: new Set(['INTENT_DURABLE', 'PASSWORD_RESET_CONFIRMED', 'PASSWORD_RESET_FAILED', 'PASSWORD_RESET_AMBIGUOUS']),
  PASSWORD_RESET_CONFIRMED: new Set(['JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  PASSWORD_RESET_FAILED: new Set(['JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  PASSWORD_RESET_AMBIGUOUS: new Set(['JOURNAL_CORRUPT', 'JOURNAL_MISSING']),
  JOURNAL_CORRUPT: new Set(),
  JOURNAL_MISSING: new Set(),
};

export const transitionManagedRecovery = (
  record: DurableManagedUserMutation,
  state: ManagedRecoveryState,
  now: number,
  patch: Partial<Pick<DurableManagedUserMutation,
    'targetUid' | 'before' | 'baselineRequestBytes' | 'lastErrorCode'>> = {},
): DurableManagedUserMutation => {
  if (record.state !== state && !TRANSITIONS[record.state].has(state)) {
    throw new Error(`MANAGED_USER_STATE_TRANSITION_INVALID:${record.state}:${state}`);
  }
  const next = { ...record, ...patch, state, updatedAt: now };
  assertDurableManagedUserMutation(next);
  return next;
};

export const readManagedRecoveryJournal = (
  storage: Pick<StorageLike, 'getItem'>,
  key: string,
): DurableManagedUserMutation[] => {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MANAGED_USER_JOURNAL_CORRUPT');
  }
  if (!Array.isArray(parsed)) throw new Error('MANAGED_USER_JOURNAL_CORRUPT');
  const records: DurableManagedUserMutation[] = [];
  const ids = new Set<string>();
  for (const value of parsed) {
    try {
      assertDurableManagedUserMutation(value);
    } catch {
      throw new Error('MANAGED_USER_JOURNAL_CORRUPT');
    }
    if (ids.has(value.id)) throw new Error('MANAGED_USER_JOURNAL_CORRUPT');
    ids.add(value.id);
    records.push(value);
  }
  return records;
};

export const writeManagedRecoveryJournal = (
  storage: StorageLike,
  key: string,
  records: DurableManagedUserMutation[],
): void => {
  records.forEach(assertDurableManagedUserMutation);
  const encoded = JSON.stringify(records);
  storage.setItem(key, encoded);
  if (storage.getItem(key) !== encoded) throw new Error('MANAGED_USER_MUTATION_DURABILITY_FAILED');
};
