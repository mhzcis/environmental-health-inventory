import { Box } from '@mui/material';

export const EMOJI_MAP: Record<string, string> = {
  // الحركات
  'كل الحركات': '📑',
  'كافة الحركات': '📑',
  'وارد': '📥',
  'صادر': '📤',
  'مستهلك': '🗑️',
  'تحويل': '🔄',
  'تسوية': '⚖️',
  'افتتاحي': '🆕',
  
  // الأوقات
  'كل الأوقات': '⏳',
  'اليوم': '🕒',
  'الأمس': '⏪',
  'آخر 7 أيام': '📅',
  'آخر 30 يوم': '🗓️',
  'الشهر الحالي': '📆',
  'نطاق مخصص': '✏️',
  
  // المرفقات
  'كل المرفقات': '📁',
  'يحتوي مرفق': '📎',
  'بلا مرفق': '❌',
  
  // الأرصدة
  'الكل (الأرصدة والمستنفذة)': '📊',
  'متوفر بالمستودعات': '✅',
  'مستنفذ / تحت حد الأمان': '⚠️',
  
  // الخطورة
  'غير محدد': '⚪',
  'منخفض': '🟢',
  'متوسط': '🟡',
  'مرتفع': '🔴',
  
  // الأدوار
  'مدير نظام': '👑',
  'أمين مستودع': '🛡️',
  'مراجع/مُشاهد': '👁️',
  'مراجع أو مشاهد': '👁️',

    // التقارير
  'تقرير الجرد العام وجرد الأرصدة المتوفرة حالياً': '📊',
  'تقرير إنفاد مخزون الأمان': '⚠️',
  'تقرير كشف فترات الصلاحيات وحالة الأصناف المشروطة بالصلاحية': '📅',
  'سجل حركات المستودع التفصيلي': '🔄',
  'تقرير الموازنة والملخص الشامل': '🏢',
  'سند توثيق الأرصدة الافتتاحية': '📋',
  
    // وحدات القياس
  'لتر': '💧',
  'كجم': '⚖️',
  'قطعة': '🧩',
  'علبة': '🥫',
  'جالون': '🛢️',
  
  // سجل العمليات

  'كل الأحداث المسجلة': '📋',
  'المواد واللوازم': '📦',
  'مستودع المبيدات': '🧪',
  'حركة مخازن وصرف': '🔄',
  'تهيئة وتحديث إعدادات': '⚙️',

  // أخرى ثابتة
  'كل التصنيفات': '📁',
  'كل التصنيفات العامة': '📁',
  'كل الفئات والتصنيفات': '📁',
  'كل المنفذين': '👥',
  'كل الجهات والشركاء': '👥',
  'جهة غير محددة': '⚪', // Or 👤 if partner
  'مورد جديد...': '➕',
  'مورد آخر...': '➕',
  'جهة مستلمة أخرى...': '➕',
  'كل الأصناف المدرجة بالمخازن': '🏷️',
  'جميع المستودعات (شامل)': '🌐',
  'جميع المستودعات': '🏢',
};

export type DynamicType = 'storehouse' | 'partner' | 'item' | 'category' | 'employee' | 'unit' | 'none';

export const getFallbackEmoji = (type: DynamicType) => {
  switch (type) {
    case 'storehouse': return '🏢';
    case 'partner': return '👤';
    case 'employee': return '👤';
    case 'item': return '🏷️';
    case 'category': return '📁';
    case 'unit': return '📏';
    default: return '';
  }
};

export const renderOption = (label: string, dynamicType: DynamicType = 'none') => {
  // Clean existing common emojis if accidentally passed from hardcoded strings
  let cleanLabel = label.replace(/[📑📥📤🗑️🔄⚖️🆕⏳🕒⏪📅🗓️📆✏️📁📎❌📊✅⚠️⚪🟢🟡🔴👑🛡️👁️👥👤➕🏷️🏢🌐📦🧪⚙️📋💧🧩🥫🛢️📏]/g, '').trim();
  if (cleanLabel.endsWith('()')) cleanLabel = cleanLabel.replace('()', '').trim();
  
  const mappedEmoji = EMOJI_MAP[cleanLabel] || EMOJI_MAP[label];
  const fallbackEmoji = getFallbackEmoji(dynamicType);
  const finalEmoji = mappedEmoji || fallbackEmoji;

  return (
    <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontFamily: '"Cairo", sans-serif', fontSize: '0.95rem', fontWeight: 600 }}>
      {finalEmoji && <Box component="span" sx={{ fontSize: '1.2em', display: 'flex', alignItems: 'center', lineHeight: 1 }}>{finalEmoji}</Box>}
      <Box component="span" sx={{ lineHeight: 1.4 }}>{cleanLabel || label}</Box>
    </Box>
  );
};
