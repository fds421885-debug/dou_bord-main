import { createRoot } from 'react-dom/client';
import { DuoLoading } from './components/DuoLoading';
import { syncPlatformDbBeforeBoot } from './firebaseConfigBootstrap';
import './index.css';

async function bootstrap() {
  const rootEl = document.getElementById('root')!;
  const root = createRoot(rootEl);

  // Immediately show Duolingo loader with percentage while checking which database the programmer set active
  root.render(
    <DuoLoading
      variant="fullscreen"
      title="جاري التحميل، الرجاء الانتظار قليلاً..."
      subtitle="يتم التأكد من قاعدة البيانات المعتمدة من المبرمج لنقلك إليها تلقائياً"
      percent={12}
      accent="green"
    />
  );

  const bootStatus = await syncPlatformDbBeforeBoot((progress) => {
    root.render(
      <DuoLoading
        variant="fullscreen"
        title={progress.title}
        subtitle={progress.subtitle}
        detail={progress.detail}
        percent={progress.percent}
        accent="blue"
      />
    );
  });

  if (bootStatus.switchedOnBoot) {
    root.render(
      <DuoLoading
        variant="fullscreen"
        title="جاري التحميل، الرجاء الانتظار قليلاً..."
        subtitle="تم العثور على القاعدة المعتمدة الحالية — جاري نقلك لتسجيل الدخول واستكمال العمل"
        detail="جاري تجهيز الاتصال بالقاعدة المعتمدة"
        percent={100}
        accent="blue"
      />
    );
    await new Promise((resolve) => window.setTimeout(resolve, 420));
  }

  const { default: App } = await import('./App.tsx');
  root.render(<App />);
}

void bootstrap();
