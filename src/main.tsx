import { createRoot } from 'react-dom/client';
import { syncPlatformDbBeforeBoot } from './firebaseConfigBootstrap';
import './index.css';

async function bootstrap() {
  await syncPlatformDbBeforeBoot();
  const { default: App } = await import('./App.tsx');
  createRoot(document.getElementById('root')!).render(<App />);
}

void bootstrap();
