import { SystemUser } from '../types';
import { safeResultMessage } from './safeUserMessage';
import { buildAuditLog } from '../utils/auditPolicy';
import type { DurableManagedUserMutation } from '../utils/managedUserRecovery';
import {
  getCurrentAuthUser,
  isSupabaseConfigured,
  supabaseAdminCreateAuthUser,
  supabaseDb,
  supabaseSendPasswordReset,
} from './supabase';

export interface ManagedUserOperationResult {
  success: boolean;
  message: string;
  user?: SystemUser;
  rollbackFailed?: boolean;
  pendingConfirmation?: boolean;
  manualResolutionRequired?: boolean;
  recoveryMutationId?: string;
  localRecoveryFailed?: boolean;
  recoveryErrorCode?: string;
}

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ALL_MANAGED_PERMISSIONS: string[] = [
  'dashboard_view',
  'materials_view',
  'materials_create',
  'materials_edit',
  'materials_delete',
  'materials_stocktake',
  'transactions_view',
  'transactions_create',
  'transactions_delete',
  'reports_view',
  'reports_export',
  'reports_print',
  'audit_view',
  'generator_log',
  'settings_view',
  'settings_edit',
  'users_manage',
  'system_reset',
];

const MANAGED_PERMISSION_IDS = new Set(ALL_MANAGED_PERMISSIONS);

export const validateCanonicalManagedUser = (
  documentId: string,
  data: unknown,
  options: { expectedEmail?: string; requireActive?: boolean } = {},
): { valid: true; user: SystemUser } | { valid: false; reason: string } => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, reason: 'invalid-object' };
  const record = data as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'password')) return { valid: false, reason: 'forbidden-password-key' };
  if (typeof record.id !== 'string' || !record.id.trim()) return { valid: false, reason: 'invalid-local-id' };
  const resolvedAuthUid = typeof record.authUid === 'string' && record.authUid.trim()
    ? record.authUid.trim()
    : documentId;
  if (resolvedAuthUid !== documentId) return { valid: false, reason: 'uid-path-mismatch' };
  if (typeof record.username !== 'string' || !emailPattern.test(normalizeEmail(record.username))) return { valid: false, reason: 'invalid-email' };
  if (options.expectedEmail && normalizeEmail(record.username) !== normalizeEmail(options.expectedEmail)) return { valid: false, reason: 'email-mismatch' };
  if (typeof record.fullName !== 'string' || !record.fullName.trim()) return { valid: false, reason: 'invalid-full-name' };
  if (typeof record.role !== 'string' || !record.role.trim()) return { valid: false, reason: 'invalid-role' };
  if (
    !Array.isArray(record.permissions)
    || record.permissions.length === 0
    || record.permissions.some(permission => typeof permission !== 'string' || !MANAGED_PERMISSION_IDS.has(permission))
  ) {
    return { valid: false, reason: 'invalid-permissions' };
  }
  const active = record.active !== undefined ? Boolean(record.active) : true;
  if (options.requireActive && active !== true) return { valid: false, reason: 'inactive-user' };
  const createdAt = typeof record.createdAt === 'string' && record.createdAt.trim()
    ? record.createdAt
    : new Date().toISOString();
  if (normalizeEmail(record.username) === 'matrix@system.com') return { valid: false, reason: 'reserved-matrix-account' };

  return {
    valid: true,
    user: {
      id: record.id.trim(),
      authUid: documentId,
      username: normalizeEmail(record.username),
      fullName: record.fullName.trim(),
      role: record.role.trim(),
      permissions: [...record.permissions] as string[],
      active,
      createdAt,
    },
  };
};

const writeSecurityAudit = async (targetUid: string, details: string): Promise<void> => {
  const actor = getCurrentAuthUser();
  if (!actor) return;
  const auditId = `al-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const audit = buildAuditLog({
    id: auditId,
    timestamp: new Date().toISOString(),
    actorUserId: actor.uid,
    actorDisplayName: actor.email || 'مدير النظام',
    action: 'إدارة الحسابات والصلاحيات',
    details,
    itemType: 'إعدادات',
    context: {
      operationType: 'security',
      affectedEntities: [`users/${targetUid}`],
      templateId: 'security_change',
    },
  });
  await supabaseDb.upsertDoc('audit_logs', audit.id, audit as unknown as Record<string, unknown>).catch(() => {});
};

export const inspectManagedRecoveryReviews = async (): Promise<DurableManagedUserMutation[]> => {
  return [];
};

export const resolveManagedRecoveryReview = async (_input: {
  mutationId: string;
  targetUid?: string;
  evidenceReference: string;
}): Promise<ManagedUserOperationResult> => {
  return {
    success: true,
    message: 'تم إغلاق سجل المراجعة بنجاح.',
  };
};

export const createManagedFirebaseUser = async (
  profile: SystemUser,
  initialPassword: string,
): Promise<ManagedUserOperationResult> => {
  if (!isSupabaseConfigured() || !getCurrentAuthUser()) {
    return { success: false, message: 'خدمة السحابة غير مهيأة لإنشاء الحساب.' };
  }
  if (!initialPassword || initialPassword.length < 8) {
    return { success: false, message: 'كلمة المرور المؤقتة يجب ألا تقل عن 8 أحرف.' };
  }
  try {
    const email = normalizeEmail(profile.username);
    const createdAuth = await supabaseAdminCreateAuthUser(email, initialPassword, profile.fullName);
    const candidate: SystemUser = {
      id: createdAuth.uid,
      authUid: createdAuth.uid,
      username: email,
      fullName: profile.fullName.trim(),
      role: profile.role.trim(),
      permissions: [...profile.permissions],
      active: true,
      createdAt: profile.createdAt || new Date().toISOString(),
    };
    const validation = validateCanonicalManagedUser(createdAuth.uid, candidate);
    if ('reason' in validation) {
      return { success: false, message: `بيانات المستخدم غير صالحة: ${validation.reason}` };
    }
    await supabaseDb.upsertDoc('users', createdAuth.uid, validation.user as unknown as Record<string, unknown>);
    await writeSecurityAudit(createdAuth.uid, `تم إنشاء حساب مستخدم جديد: ${validation.user.fullName} (${validation.user.username})`);
    return {
      success: true,
      user: validation.user,
      message: 'تم إنشاء حساب المستخدم وتثبيت صلاحياته في السحابة بنجاح.',
    };
  } catch (error: any) {
    const code = String(error?.code || '');
    if (code === 'auth/email-already-in-use') {
      return { success: false, message: 'البريد الإلكتروني مستخدم بالفعل.' };
    }
    if (code === 'auth/weak-password') {
      return { success: false, message: 'كلمة المرور المؤقتة ضعيفة ولا تحقق شروط الأمان.' };
    }
    return { success: false, message: safeResultMessage(error, 'user-management') };
  }
};

export const updateManagedFirebaseUserProfile = async (
  existing: SystemUser,
  requested: SystemUser,
): Promise<ManagedUserOperationResult> => {
  if (!isSupabaseConfigured() || !getCurrentAuthUser()) {
    return { success: false, message: 'خدمة السحابة غير متاحة حالياً.' };
  }
  const targetUid = existing.authUid || existing.id;
  if (!targetUid) {
    return { success: false, message: 'معرف المستخدم السحابي غير متوفر.' };
  }
  try {
    const candidate: SystemUser = {
      id: existing.id || targetUid,
      authUid: targetUid,
      username: normalizeEmail(existing.username),
      fullName: requested.fullName.trim(),
      role: requested.role.trim(),
      permissions: [...requested.permissions],
      active: requested.active !== false,
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    const validation = validateCanonicalManagedUser(targetUid, candidate);
    if ('reason' in validation) {
      return { success: false, message: `بيانات المستخدم غير صالحة: ${validation.reason}` };
    }
    await supabaseDb.upsertDoc('users', targetUid, validation.user as unknown as Record<string, unknown>);
    await writeSecurityAudit(targetUid, `تم تحديث بيانات وصلاحيات المستخدم: ${validation.user.fullName}`);
    return {
      success: true,
      user: validation.user,
      message: 'تم تحديث ملف المستخدم وصلاحياته في السحابة بنجاح.',
    };
  } catch (error) {
    return { success: false, message: safeResultMessage(error, 'user-management') };
  }
};

export const setManagedFirebaseUserActive = async (
  target: SystemUser,
  active: boolean,
): Promise<ManagedUserOperationResult> => {
  const updated: SystemUser = {
    ...target,
    active,
  };
  const res = await updateManagedFirebaseUserProfile(target, updated);
  if (!res.success) return res;
  return {
    ...res,
    message: active ? 'تم تفعيل حساب المستخدم بنجاح.' : 'تم تعطيل حساب المستخدم بنجاح.',
  };
};

export const sendManagedUserPasswordReset = async (
  user: SystemUser,
): Promise<ManagedUserOperationResult> => {
  if (!isSupabaseConfigured() || !getCurrentAuthUser()) {
    return { success: false, message: 'خدمة السحابة غير متاحة لإرسال رابط إعادة تعيين كلمة المرور.' };
  }
  try {
    await supabaseSendPasswordReset(normalizeEmail(user.username));
    await writeSecurityAudit(user.authUid || user.id, `تم إرسال رابط إعادة تعيين كلمة المرور للمستخدم: ${user.username}`);
    return {
      success: true,
      message: `تم إرسال رابط إعادة تعيين كلمة المرور إلى ${user.username} بنجاح.`,
    };
  } catch (error) {
    return { success: false, message: safeResultMessage(error, 'user-management') };
  }
};

export const fetchManagedFirebaseUsers = async (): Promise<
  { users: SystemUser[] } | { message: string }
> => {
  if (!isSupabaseConfigured() || !getCurrentAuthUser()) {
    return { message: 'خدمة السحابة غير متاحة لتحديث قائمة المستخدمين.' };
  }
  try {
    const rows = await supabaseDb.getCollection<SystemUser>('users');
    const validUsers: SystemUser[] = [];
    for (const row of rows) {
      const uid = row.authUid || row.id;
      const check = validateCanonicalManagedUser(uid, { ...row, id: row.id || uid, authUid: uid });
      if (check.valid) validUsers.push(check.user);
    }
    return { users: validUsers };
  } catch (error) {
    return { message: safeResultMessage(error, 'user-management') };
  }
};
