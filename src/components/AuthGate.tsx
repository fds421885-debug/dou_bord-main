import React, { useEffect, useState } from 'react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from '../firestoreTracked';
import { LogIn, UserCheck, AlertCircle, LogOut } from 'lucide-react';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  isQuadNameValid,
  OperationType,
} from '../firebase';
import { saveSessionSnapshot } from '../localDraftStore';
import type { UserProfile } from '../types';
import { DUO_IMAGES, DuoArtwork, playDuoSound } from './DuoIcons';

interface AuthGateProps {
  firebaseUser: User | null;
  profile: UserProfile | null;
  onProfileSaved: (profile: UserProfile) => void;
  onQuotaDetected?: () => void;
}

function formatAuthOrFirestoreError(err: unknown, user?: User | null): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('quota exceeded') || lower.includes('resource-exhausted')) {
    return 'تم الوصول للحد الأقصى مؤقتاً، جاري التبديل تلقائياً لقاعدة بيانات بديلة...';
  }
  if (lower.includes('auth/unauthorized-domain')) {
    return 'هذا النطاق (مثل Netlify) غير مضاف في النطاقات المصرح بها (Authorized domains) في إعدادات Firebase Authentication.';
  }
  if (lower.includes('auth/popup-blocked')) {
    return 'تم حظر نافذة تسجيل الدخول من المتصفح، يرجى السماح بالنوافذ المنبثقة والمحاولة مرة أخرى.';
  }
  if (lower.includes('auth/popup-closed-by-user')) {
    return 'تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.';
  }
  if (user && !user.emailVerified) {
    return 'بريد هذا الحساب غير مفعّل (email_verified). يرجى تسجيل الدخول بحساب Google مُفعّل البريد.';
  }
  if (lower.includes('permission-denied') || lower.includes('permission_denied')) {
    return 'تعذر حفظ الاسم الرباعي بسبب رفض الصلاحيات من قاعدة البيانات (PERMISSION_DENIED). تأكد من أن البريد مفعّل وحاول تسجيل الخروج ثم الدخول مجدداً.';
  }
  if (lower.includes('offline') || lower.includes('unavailable') || lower.includes('network')) {
    return 'تعذر الاتصال بقاعدة البيانات حالياً. تحقق من اتصال الإنترنت وحاول مرة أخرى.';
  }
  return `حدث خطأ أثناء حفظ الاسم الرباعي: ${raw}`;
}

export const AuthGate: React.FC<AuthGateProps> = ({
  firebaseUser,
  profile,
  onProfileSaved,
  onQuotaDetected,
}) => {
  const [quadName, setQuadName] = useState(profile?.fullNameQuad ?? '');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (profile?.fullNameQuad) {
      setQuadName(profile.fullNameQuad);
      return;
    }
    if (firebaseUser) {
      try {
        const cached = localStorage.getItem(`duoboard_quad_${firebaseUser.uid}`);
        if (cached && !quadName) {
          setQuadName(cached);
        }
      } catch {
        // Ignore storage errors
      }
    }
  }, [firebaseUser?.uid, profile?.fullNameQuad]);

  const handleGoogleLogin = async () => {
    setErrorMsg(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
      playDuoSound('pop');
    } catch (err) {
      setErrorMsg(formatAuthOrFirestoreError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveQuadName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseUser) return;

    const cleaned = quadName.trim().replace(/\s+/g, ' ');
    if (!isQuadNameValid(cleaned) || cleaned.length > 120) {
      setErrorMsg('يرجى إدخال الاسم الرباعي كاملاً (أربع كلمات على الأقل وبحد أقصى 120 حرفاً، مثل: محمد أحمد علي السالم)');
      return;
    }

    setErrorMsg(null);
    setLoading(true);
    const path = `users/${firebaseUser.uid}/private/profile`;
    const profileRef = doc(db, 'users', firebaseUser.uid, 'private', 'profile');

    try {
      const existingSnap = await getDoc(profileRef);
      if (existingSnap.exists()) {
        await updateDoc(profileRef, {
          fullNameQuad: cleaned,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(profileRef, {
          uid: firebaseUser.uid,
          fullNameQuad: cleaned,
          email: firebaseUser.email || 'user@example.com',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      try {
        localStorage.setItem(`duoboard_quad_${firebaseUser.uid}`, cleaned);
        localStorage.setItem('duoboard_last_quad_name', cleaned);
      } catch {
        // Ignore storage errors
      }
      void saveSessionSnapshot({
        key: 'user_profile',
        uid: firebaseUser.uid,
        fullNameQuad: cleaned,
        email: firebaseUser.email || 'user@example.com',
        updatedAt: Date.now(),
      });

      playDuoSound('correct');
      onProfileSaved({
        uid: firebaseUser.uid,
        fullNameQuad: cleaned,
        email: firebaseUser.email || 'user@example.com',
      });
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, path);
      } catch (wrapped) {
        console.error(wrapped);
      }
      const rawErr = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      if (rawErr.includes('quota exceeded') || rawErr.includes('resource-exhausted')) {
        onQuotaDetected?.();
      }
      setErrorMsg(formatAuthOrFirestoreError(err, firebaseUser));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FFFFFF] flex flex-col">
      {/* Minimal Duolingo Top Bar */}
      <header className="border-b-2 border-[#E5E5E5] bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="font-latin text-2xl font-black tracking-tight text-[#58CC02] whitespace-nowrap">
              DuoBoard
            </span>
          </div>
          {firebaseUser && (
            <button
              type="button"
              onClick={() => void signOut(auth)}
              className="duo-btn flex items-center gap-2 px-4 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-extrabold text-[#777777] hover:text-[#3C3C3C] cursor-pointer whitespace-nowrap shrink-0"
            >
              <LogOut className="w-4 h-4" />
              <span>تبديل الحساب</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
          {/* Mascot & Intro */}
          <div className="flex flex-col items-center lg:items-start text-center lg:text-right">
            <DuoArtwork
              src={DUO_IMAGES.welcome}
              alt="شخصية دُو بورد التعليمية"
              className="w-48 h-48 sm:w-56 sm:h-56 mb-5"
            />
            <h1 className="text-3xl sm:text-4xl font-black text-[#3C3C3C] leading-tight mb-3 text-balance">
              سبورات ذكية متزامنة للمشرف والطلاب
            </h1>
            <p className="text-base font-bold text-[#777777] leading-relaxed max-w-md">
              سجّل دخولك أولاً باسمك الرباعي لتُحفظ جميع اختباراتك وصبوراتك في حسابك وتتمكن من استعراضها أو حذفها في أي وقت.
            </p>
          </div>

          {/* Auth / Quad Name Card */}
          <div className="duo-card p-6 sm:p-8">
            {!firebaseUser ? (
              <div className="flex flex-col gap-5">
                <div>
                  <h2 className="text-2xl font-black text-[#3C3C3C] mb-1">
                    تسجيل الدخول للبدء
                  </h2>
                  <p className="text-sm font-bold text-[#777777]">
                    الخطوة الأولى: ربط حسابك لحفظ الاختبارات والسبورات بشكل دائم
                  </p>
                </div>

                {errorMsg && (
                  <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-sm font-bold">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <button
                  type="button"
                  disabled={loading}
                  onClick={handleGoogleLogin}
                  className="duo-btn w-full flex items-center justify-center gap-3 px-6 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                >
                  <LogIn className="w-5 h-5" />
                  <span>{loading ? 'جاري تسجيل الدخول...' : 'الدخول عبر حساب Google'}</span>
                </button>
              </div>
            ) : (
              <form onSubmit={handleSaveQuadName} className="flex flex-col gap-5">
                <div>
                  <h2 className="text-2xl font-black text-[#3C3C3C] mb-1">
                    أدخل اسمك الرباعي
                  </h2>
                  <p className="text-sm font-bold text-[#777777]">
                    سيظهر اسمك الرباعي للمشرف وفي لوحة النتائج وسجل الاختبارات المحفوظة
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="quad-name-input"
                    className="text-sm font-extrabold text-[#3C3C3C]"
                  >
                    الاسم الرباعي الكامل
                  </label>
                  <input
                    id="quad-name-input"
                    type="text"
                    required
                    value={quadName}
                    onChange={(e) => setQuadName(e.target.value)}
                    placeholder="مثال: أحمد محمد علي السالم"
                    className="w-full px-4 py-3.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-base font-bold text-[#3C3C3C] transition-colors"
                  />
                  <span className="text-xs font-bold text-[#777777]">
                    يجب كتابة الاسم من 4 أجزاء مفصولة بمسافات
                  </span>
                </div>

                {errorMsg && (
                  <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-sm font-bold">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="duo-btn w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                >
                  <UserCheck className="w-5 h-5" />
                  <span>{loading ? 'جاري الحفظ...' : 'حفظ الاسم والمتابعة'}</span>
                </button>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
