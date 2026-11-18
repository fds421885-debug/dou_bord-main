import { createRoot } from 'react-dom/client';
import { DuoLoading } from './components/DuoLoading';
import { syncPlatformDbBeforeBoot } from './firebaseConfigBootstrap';
import './index.css';

async function bootstrap() {
  const rootEl = document.getElementById('root')!;
  const root = createRoot(rootEl);

  // Immediately show modern Duolingo loader while fetching active platform database before Firebase initializes
  root.render(
    <DuoLoading
      variant="fullscreen"
      title="جاري الاتصال بالمنصة وتحديد قاعدة البيانات الحالية..."
      subtitle="يتم تحميل أحدث إعدادات الدخول والمزامنة لضمان انضمامك مع الجميع مباشرة"
      accent="green"
    />
  );

  await syncPlatformDbBeforeBoot();
  const { default: App } = await import('./App.tsx');
  root.render(<App />);
}

void bootstrap();
