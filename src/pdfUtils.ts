import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function canvasToBoundedJpeg(sourceCanvas: HTMLCanvasElement, maxLength = 435000): string {
  let workingCanvas = sourceCanvas;
  const scales = [1, 0.82, 0.66, 0.5];

  for (const scaleFactor of scales) {
    if (scaleFactor < 1) {
      const scaled = document.createElement('canvas');
      scaled.width = Math.max(240, Math.round(sourceCanvas.width * scaleFactor));
      scaled.height = Math.max(180, Math.round(sourceCanvas.height * scaleFactor));
      const sCtx = scaled.getContext('2d');
      if (sCtx) {
        sCtx.fillStyle = '#FFFFFF';
        sCtx.fillRect(0, 0, scaled.width, scaled.height);
        sCtx.drawImage(sourceCanvas, 0, 0, scaled.width, scaled.height);
        workingCanvas = scaled;
      }
    }

    let quality = 0.82;
    let dataUrl = workingCanvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > maxLength && quality > 0.34) {
      quality -= 0.1;
      dataUrl = workingCanvas.toDataURL('image/jpeg', quality);
    }

    if (workingCanvas !== sourceCanvas) {
      workingCanvas.width = 0;
      workingCanvas.height = 0;
    }

    if (dataUrl.length <= 470000) {
      return dataUrl;
    }
  }

  throw new Error('حجم الصفحة كبير جداً، يرجى استخدام ملف أقل دقة');
}

export async function renderPdfToSlideImagesWithMeta(
  file: File,
  onProgress?: (current: number, total: number) => void,
  maxPages = 100
): Promise<{ pages: string[]; totalPdfPages: number }> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  const totalPdfPages = pdf.numPages;
  const total = Math.min(totalPdfPages, Math.max(1, maxPages));
  const pages: string[] = [];
  const canvas = document.createElement('canvas');

  try {
    for (let i = 1; i <= total; i++) {
      onProgress?.(i, total);
      const page = await pdf.getPage(i);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const targetMax = total > 40 ? 1120 : 1280;
        const scale = Math.min(
          targetMax / baseViewport.width,
          (targetMax * 0.9) / baseViewport.height,
          1.8
        );
        const viewport = page.getViewport({ scale: Math.max(scale, 0.75) });

        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('تعذر تجهيز صفحة PDF للعرض');

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        }).promise;

        pages.push(canvasToBoundedJpeg(canvas));
      } finally {
        page.cleanup();
      }

      if (i % 8 === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    try {
      await pdf.cleanup();
    } catch {
      // ignore cleanup error
    }
    try {
      await loadingTask.destroy();
    } catch {
      // ignore destroy error
    }
  }

  return { pages, totalPdfPages };
}

export async function renderPdfToSlideImages(
  file: File,
  onProgress?: (current: number, total: number) => void,
  maxPages = 100
): Promise<string[]> {
  const { pages } = await renderPdfToSlideImagesWithMeta(file, onProgress, maxPages);
  return pages;
}

export async function compressSlideImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذر قراءة الصورة'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('تنسيق الصورة غير مدعوم'));
      img.onload = () => {
        const maxDim = 1280;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('تعذر معالجة الصورة'));
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        try {
          const out = canvasToBoundedJpeg(canvas);
          canvas.width = 0;
          canvas.height = 0;
          resolve(out);
        } catch (err) {
          canvas.width = 0;
          canvas.height = 0;
          reject(err);
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
