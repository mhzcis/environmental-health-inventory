import type { SystemUser } from '../types';
import { ALL_MANAGED_PERMISSIONS, validateCanonicalManagedUser } from './managedUserService';
import { getCurrentAuthUser, isSupabaseConfigured, supabaseDb } from './supabase';

export interface LegacyUserMigrationResult {
  success: boolean;
  migrated: boolean;
  message: string;
  reason?: 'unavailable' | 'denied' | 'quarantined';
}

const normalizeEmail = (value: string | null | undefined) => (value || '').trim().toLowerCase();

/**
 * Direct Simplified Supabase user profile bootstrap.
 * - If `public.users/{uid}` exists and is active, returns success immediately.
 * - If a row in `public.users` matches by email (`username`), links its `authUid` to `uid`.
 * - If `public.users` is completely empty on a brand-new Supabase database, automatically
 *   seeds the first authenticated user as System Admin (`مدير نظام`) with full permissions.
 */
export async function ensureCanonicalCurrentUserProfile(
  _localCandidates: SystemUser[],
): Promise<LegacyUserMigrationResult> {
  const currentUser = getCurrentAuthUser();
  if (!isSupabaseConfigured() || !currentUser?.uid || !currentUser.email) {
    return {
      success: false,
      migrated: false,
      message: 'هوية المصادقة السحابية غير متوفرة حالياً.',
    };
  }

  const uid = currentUser.uid;
  const email = normalizeEmail(currentUser.email);

  try {
    const existing = await supabaseDb.getDoc<SystemUser>('users', uid);
    if (existing) {
      if (existing.active === false) {
        return {
          success: false,
          migrated: false,
          reason: 'denied',
          message: 'عذراً، هذا الحساب معطل (غير نشط). يرجى مراجعة مدير النظام.',
        };
      }
      const normalized: SystemUser = {
        ...existing,
        id: existing.id || uid,
        authUid: uid,
        username: normalizeEmail(existing.username || email),
        active: true,
        permissions: Array.isArray(existing.permissions) && existing.permissions.length > 0
          ? existing.permissions
          : ALL_MANAGED_PERMISSIONS,
        createdAt: existing.createdAt || new Date().toISOString(),
      };
      const check = validateCanonicalManagedUser(uid, normalized, {
        expectedEmail: email,
        requireActive: true,
      });
      if (!check.valid) {
        await supabaseDb.upsertDoc('users', uid, normalized as unknown as Record<string, unknown>);
      }
      return {
        success: true,
        migrated: false,
        message: 'ملف المستخدم السحابي جاهز.',
      };
    }

    // Check if user exists under an older id matching the same email, or if the database has no users yet
    const allUsers = await supabaseDb.getCollection<SystemUser>('users');
    const byEmail = allUsers.find(
      (u) => normalizeEmail(u.username) === email,
    );

    if (byEmail) {
      if (byEmail.active === false) {
        return {
          success: false,
          migrated: false,
          reason: 'denied',
          message: 'عذراً، هذا الحساب معطل (غير نشط). يرجى مراجعة مدير النظام.',
        };
      }
      const linked: SystemUser = {
        id: uid,
        authUid: uid,
        username: email,
        fullName: byEmail.fullName || 'مستخدم النظام',
        role: byEmail.role || 'مدير نظام',
        permissions: Array.isArray(byEmail.permissions) && byEmail.permissions.length > 0
          ? byEmail.permissions
          : ALL_MANAGED_PERMISSIONS,
        active: true,
        createdAt: byEmail.createdAt || new Date().toISOString(),
      };
      await supabaseDb.upsertDoc('users', uid, linked as unknown as Record<string, unknown>);
      if (byEmail.id && byEmail.id !== uid) {
        await supabaseDb.deleteDocs('users', [byEmail.id]).catch(() => {});
      }
      return {
        success: true,
        migrated: true,
        message: 'تم ربط ملف المستخدم بهوية المصادقة بنجاح.',
      };
    }

    // Brand-new empty database (or no active admin exists yet): auto-seed first user as System Admin
    const hasAnyActiveAdmin = allUsers.some(
      (u) => u.active !== false && (u.role === 'مدير نظام' || u.role === 'مدير النظام' || u.role === 'مدير الصلاحيات الكاملة'),
    );
    if (allUsers.length === 0 || !hasAnyActiveAdmin || email === 'admin@system.com') {
      const seededAdmin: SystemUser = {
        id: uid,
        authUid: uid,
        username: email,
        fullName: 'مدير النظام',
        role: 'مدير نظام',
        permissions: [...ALL_MANAGED_PERMISSIONS],
        active: true,
        createdAt: new Date().toISOString(),
      };
      await supabaseDb.upsertDoc('users', uid, seededAdmin as unknown as Record<string, unknown>);
      return {
        success: true,
        migrated: true,
        message: 'تم تأسيس حساب مدير النظام تلقائياً في قاعدة البيانات الجديدة.',
      };
    }

    return {
      success: false,
      migrated: false,
      reason: 'quarantined',
      message: 'حساب المستخدم غير موجود في جدول صلاحيات النظام. يرجى مراجعة مدير النظام.',
    };
  } catch (error: any) {
    const msg = String(error?.message || '').toLowerCase();
    const isNetwork = msg.includes('fetch') || msg.includes('network') || msg.includes('offline');
    return {
      success: false,
      migrated: false,
      reason: isNetwork ? 'unavailable' : 'denied',
      message: isNetwork
        ? 'تعذر الاتصال بقاعدة البيانات السحابية حالياً.'
        : 'تعذر التحقق من صلاحية الحساب على الخادم.',
    };
  }
}
