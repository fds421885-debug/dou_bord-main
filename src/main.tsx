import { createRoot } from 'react-dom/client';
import { DuoLoading } from './components/DuoLoading';
import { syncPlatformDbBeforeBoot } from './firebaseConfigBootstrap';
import './index.css';

async function bootstrap() {
  const rootEl = document.getElementById('root')!;
  const root = createRoot(rootEl);

  // Immediately show Duolingo loader while checking which database the programmer set active
  root.render(
    <DuoLoading
      variant="fullscreen"
      title="جاري التحميل، الرجاء الانتظار قليلاً..."
      subtitle="يتم التأكد من قاعدة البيانات المعتمدة من المبرمج لنقلك إليها تلقائياً"
      accent="green"
    />
  );

  const bootStatus = await syncPlatformDbBeforeBoot();
  if (bootStatus.switchedOnBoot) {
    root.render(
      <DuoLoading
        variant="fullscreen"
        title="جاري التحميل، الرجاء الانتظار قليلاً..."
        subtitle="تم العثور على القاعدة المعتمدة الحالية — جاري نقلك إليها الآن"
        percent={100}
        accent="blue"
      />
    );
    await new Promise((resolve) => window.setTimeout(resolve, 380));
  }

  const { default: App } = await import('./App.tsx');
  root.render(<App />);
}

void bootstrap();
