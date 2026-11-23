import React, { useEffect, useState } from 'react';
import { Bell, BellOff, Check, Download, Share, Smartphone, X } from 'lucide-react';
import {
  getNotificationPermission,
  isNotificationsEnabledPref,
  requestNotificationPermissionSafe,
  setNotificationsEnabledPref,
  useOnlineStatus,
  usePWAInstall,
  type NotificationPermState,
} from '../pwa';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { canNativeInstall, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const isOnline = useOnlineStatus();
  const [perm, setPerm] = useState<NotificationPermState>(() => getNotificationPermission());
  const [enabled, setEnabled] = useState<boolean>(() => isNotificationsEnabledPref());
  const [guideModal, setGuideModal] = useState<'ios' | 'desktop' | null>(null);

  useEffect(() => {
    const syncPerm = () => setPerm(getNotificationPermission());
    const syncPref = () => setEnabled(isNotificationsEnabledPref());
    window.addEventListener('duoboard:notifications-granted', syncPerm);
    window.addEventListener('duoboard:notifications-pref-changed', syncPref);
    return () => {
      window.removeEventListener('duoboard:notifications-granted', syncPerm);
      window.removeEventListener('duoboard:notifications-pref-changed', syncPref);
    };
  }, []);

  const handleInstallClick = async () => {
    const result = await promptInstall();
    if (result === 'ios') {
      setGuideModal('ios');
    } else if (result === 'unavailable') {
      setGuideModal('desktop');
    }
  };

  const handleTurnOnNotifications = async () => {
    setNotificationsEnabledPref(true);
    setEnabled(true);
    const next = await requestNotificationPermissionSafe();
    setPerm(next);
    if (next === 'granted' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('duoboard:notifications-granted'));
    }
  };

  const handleTurnOffNotifications = () => {
    setNotificationsEnabledPref(false);
    setEnabled(false);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {!isOnline && (
          <span className="px-2.5 py-1 rounded-xl bg-[#FFF4CC] border border-[#FFC800] text-[#9A6B00] text-[11px] font-black">
            بدون إنترنت — وضع العمل المحلي
          </span>
        )}

        {!enabled ? (
          <button
            type="button"
            onClick={() => void handleTurnOnNotifications()}
            className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#F7F7F7] hover:bg-[#EFEFEF] border-2 border-b-4 border-[#D9D9D9] text-[#666666] text-[11px] sm:text-xs font-black whitespace-nowrap cursor-pointer"
            title="الإشعارات مغلقة حالياً — اضغط لتفعيل الإشعارات مجدداً"
          >
            <BellOff className="w-3.5 h-3.5" />
            <span>{compact ? 'الإشعارات مغلقة' : 'الإشعارات مغلقة (اضغط للتفعيل)'}</span>
          </button>
        ) : perm === 'granted' ? (
          <button
            type="button"
            onClick={handleTurnOffNotifications}
            className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#D7FFB8] hover:bg-[#C6F69D] border-2 border-b-4 border-[#58CC02] text-[#3B8D00] text-[11px] sm:text-xs font-black whitespace-nowrap cursor-pointer"
            title="الإشعارات مفعّلة — اضغط لإغلاق الإشعارات"
          >
            <Bell className="w-3.5 h-3.5" />
            <span>{compact ? 'الإشعارات مفعّلة' : 'الإشعارات مفعّلة (اضغط للإغلاق)'}</span>
          </button>
        ) : perm === 'default' ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleTurnOnNotifications()}
              className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#FFF4CC] hover:bg-[#FFE999] border-2 border-b-4 border-[#FFC800] text-[#9A6B00] text-[11px] sm:text-xs font-black whitespace-nowrap cursor-pointer"
              title="تفعيل إشعارات الرسائل وطلبات الصداقة حتى أثناء وجودك في تطبيق آخر أو إغلاق المتصفح"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>{compact ? 'تفعيل الإشعارات' : 'تفعيل إشعارات الجهاز'}</span>
            </button>
            <button
              type="button"
              onClick={handleTurnOffNotifications}
              className="duo-btn flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-xl bg-[#F7F7F7] hover:bg-[#EFEFEF] border-2 border-b-4 border-[#E5E5E5] text-[#777777] text-[11px] sm:text-xs font-black whitespace-nowrap cursor-pointer"
              title="إغلاق وكتم الإشعارات"
            >
              <BellOff className="w-3.5 h-3.5" />
              <span>{compact ? 'إغلاق' : 'إغلاق الإشعارات'}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleTurnOffNotifications}
            className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#E6F7FF] hover:bg-[#D5F0FF] border-2 border-b-4 border-[#1CB0F6] text-[#1899D6] text-[11px] sm:text-xs font-black whitespace-nowrap cursor-pointer"
            title={
              perm === 'denied'
                ? 'إشعارات المتصفح محظورة من الإعدادات، وإشعارات التطبيق مفعّلة — اضغط للإغلاق'
                : 'إشعارات التطبيق مفعّلة — اضغط للإغلاق'
            }
          >
            <Bell className="w-3.5 h-3.5" />
            <span>
              {compact
                ? 'إشعارات التطبيق'
                : perm === 'denied'
                ? 'محظورة من المتصفح (اضغط لإغلاق تنبيهات التطبيق)'
                : 'إشعارات التطبيق مفعّلة (اضغط للإغلاق)'}
            </span>
          </button>
        )}

        {!isInstalled && (
          <button
            type="button"
            onClick={() => void handleInstallClick()}
            className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-b-4 border-[#46A302] text-white text-[11px] sm:text-xs font-black whitespace-nowrap cursor-pointer"
            title={
              canNativeInstall
                ? 'تنزيل وتثبيت التطبيق على جهازك للعمل كتطبيق مستقل'
                : isIOS
                ? 'طريقة إضافة التطبيق إلى الشاشة الرئيسية'
                : 'تثبيت التطبيق على جهازك'
            }
          >
            <Download className="w-3.5 h-3.5" />
            <span>{compact ? 'تثبيت التطبيق' : 'تنزيل التطبيق على جهازك'}</span>
          </button>
        )}

        {isInstalled && !compact && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[#E6F7FF] border border-[#1CB0F6]/50 text-[#1899D6] text-[11px] font-black">
            <Check className="w-3 h-3" />
            <span>مثبّت كتطبيق</span>
          </span>
        )}
      </div>

      {guideModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          dir="rtl"
        >
          <div className="duo-card max-w-md w-full p-5 sm:p-6 bg-white flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-[#D7FFB8] text-[#46A302] flex items-center justify-center shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-black text-[#3C3C3C]">
                    تثبيت DuoBoard على جهازك
                  </h3>
                  <p className="text-xs font-bold text-[#777777]">
                    يعمل كتطبيق مستقل مع حفظ محلي للعمل بدون إنترنت
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGuideModal(null)}
                className="p-1.5 rounded-xl text-[#777777] hover:bg-[#F7F7F7] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {guideModal === 'ios' ? (
              <div className="p-3.5 rounded-2xl bg-[#F8FAFC] border-2 border-[#E5E5E5] flex flex-col gap-2 text-xs font-bold text-[#3C3C3C] leading-relaxed">
                <p className="flex items-center gap-1.5 font-black text-[#1899D6]">
                  <Share className="w-4 h-4" /> خطوات التثبيت على آيفون وآيباد (Safari):
                </p>
                <p>1. اضغط على زر «مشاركة» (المربع مع السهم لأعلى) أسفل أو أعلى المتصفح.</p>
                <p>2. مرر للأسفل واختر «إضافة إلى الشاشة الرئيسية» (Add to Home Screen).</p>
                <p>3. اضغط «إضافة» ليظهر تطبيق DuoBoard على جهازك مثل الواتساب.</p>
              </div>
            ) : (
              <div className="p-3.5 rounded-2xl bg-[#F8FAFC] border-2 border-[#E5E5E5] flex flex-col gap-2 text-xs font-bold text-[#3C3C3C] leading-relaxed">
                <p className="font-black text-[#1899D6]">خطوات التثبيت من المتصفح:</p>
                <p>1. افتح قائمة المتصفح (النقاط الثلاث أعلى الشاشة) أو أيقونة التثبيت في شريط العنوان.</p>
                <p>2. اختر «تثبيت التطبيق» (Install app) أو «إضافة إلى الشاشة الرئيسية».</p>
                <p>3. إذا كنت داخل نافذة معاينة مضمّنة، افتح الرابط في نافذة مستقلة ليتفعّل التثبيت المباشر.</p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setGuideModal(null)}
              className="duo-btn w-full py-2.5 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white text-sm font-black cursor-pointer"
            >
              فهمت
            </button>
          </div>
        </div>
      )}
    </>
  );
};
