import React, { useState } from 'react';

export const DUO_IMAGES = {
  welcome: '/src/assets/images/duo_mascot_welcome_1794842024620.jpg',
  supervisor: '/src/assets/images/duo_supervisor_badge_1794842025115.jpg',
  student: '/src/assets/images/duo_student_badge_1794842025060.jpg',
  trophy: '/src/assets/images/duo_trophy_celebration_1794842026722.jpg',
} as const;

export const DuoArtwork: React.FC<{
  src: string;
  alt: string;
  className?: string;
  fallbackLabel?: string;
}> = ({ src, alt, className = 'w-24 h-24', fallbackLabel }) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`${className} rounded-2xl bg-[#D7FFB8] border-2 border-[#58CC02] flex items-center justify-center p-2`}
      >
        <DuoOwlEmblem className="w-12 h-12" />
        {fallbackLabel ? <span className="sr-only">{fallbackLabel}</span> : null}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${className} object-contain select-none rounded-2xl`}
    />
  );
};

export const DuoOwlEmblem: React.FC<{ className?: string }> = ({ className = 'w-8 h-8' }) => (
  <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
    <rect x="8" y="10" width="48" height="46" rx="20" fill="#58CC02" />
    <path d="M12 16L22 8L24 18Z" fill="#58CC02" />
    <path d="M52 16L42 8L40 18Z" fill="#58CC02" />
    <ellipse cx="23" cy="30" rx="10" ry="11" fill="#FFFFFF" />
    <ellipse cx="41" cy="30" rx="10" ry="11" fill="#FFFFFF" />
    <circle cx="24" cy="30" r="5" fill="#1F2937" />
    <circle cx="40" cy="30" r="5" fill="#1F2937" />
    <circle cx="26" cy="28" r="2" fill="#FFFFFF" />
    <circle cx="42" cy="28" r="2" fill="#FFFFFF" />
    <path d="M27 37C27 34.5 37 34.5 37 37L32 45L27 37Z" fill="#FFC800" />
    <path d="M22 48C25 46 39 46 42 48" stroke="#46A302" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export const DuoGemIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
    <path d="M8 5H24L29 13L16 28L3 13L8 5Z" fill="#1CB0F6" />
    <path d="M8 5H24L20 13H12L8 5Z" fill="#84D8FF" />
    <path d="M12 13H20L16 28L12 13Z" fill="#1899D6" />
  </svg>
);

export const DuoCrownIcon: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
    <path
      d="M4 24L6 10L12 16L16 7L20 16L26 10L28 24H4Z"
      fill="#FFC800"
      stroke="#E5A400"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    <rect x="4" y="24" width="24" height="4" rx="2" fill="#E5A400" />
  </svg>
);

export const DuoCheckBadge: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
    <circle cx="16" cy="16" r="14" fill="#58CC02" />
    <path
      d="M10 16.5L14 20.5L22.5 11.5"
      stroke="#FFFFFF"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const DuoCrossBadge: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
    <circle cx="16" cy="16" r="14" fill="#FF4B4B" />
    <path
      d="M11 11L21 21M21 11L11 21"
      stroke="#FFFFFF"
      strokeWidth="3.5"
      strokeLinecap="round"
    />
  </svg>
);

export const DuoLockShield: React.FC<{ className?: string }> = ({ className = 'w-12 h-12' }) => (
  <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
    <rect x="10" y="20" width="28" height="22" rx="6" fill="#AFAFAF" />
    <rect x="10" y="20" width="28" height="19" rx="6" fill="#E5E5E5" />
    <path
      d="M16 20V14C16 9.58 19.58 6 24 6C28.42 6 32 9.58 32 14V20"
      stroke="#AFAFAF"
      strokeWidth="4.5"
      strokeLinecap="round"
    />
    <circle cx="24" cy="30" r="3.5" fill="#777777" />
  </svg>
);

let audioCtx: AudioContext | null = null;

export function playDuoSound(type: 'correct' | 'wrong' | 'join' | 'finish' | 'pop') {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    const playTone = (freq: number, start: number, dur: number, wave: OscillatorType = 'sine', vol = 0.08) => {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(vol, now + start);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };

    if (type === 'correct') {
      playTone(523.25, 0, 0.14, 'triangle', 0.1);
      playTone(659.25, 0.09, 0.14, 'triangle', 0.1);
      playTone(783.99, 0.18, 0.25, 'triangle', 0.12);
    } else if (type === 'wrong') {
      playTone(300, 0, 0.16, 'sawtooth', 0.06);
      playTone(220, 0.14, 0.24, 'sawtooth', 0.06);
    } else if (type === 'join' || type === 'pop') {
      playTone(587.33, 0, 0.1, 'sine', 0.07);
      playTone(880, 0.07, 0.14, 'sine', 0.07);
    } else if (type === 'finish') {
      playTone(523.25, 0, 0.12, 'triangle', 0.09);
      playTone(659.25, 0.1, 0.12, 'triangle', 0.09);
      playTone(783.99, 0.2, 0.12, 'triangle', 0.09);
      playTone(1046.5, 0.3, 0.35, 'triangle', 0.11);
    }
  } catch {
    // Audio playback is purely optional feedback
  }
}
