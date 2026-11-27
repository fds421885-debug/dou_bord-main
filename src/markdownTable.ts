import type { DataTableVariant, QuestionDataTable } from './types';

export type MarkdownTextBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: QuestionDataTable };

export function isMarkdownDividerRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const clean = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const parts = clean.split('|').map((s) => s.trim());
  return parts.length >= 2 && parts.every((p) => /^:?-{2,}:?$/.test(p));
}

export function splitMarkdownPipeCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((s) => s.trim());
}

function isPipeTableLine(line: string): boolean {
  const t = line.trim();
  if (!t || !t.startsWith('|')) return false;
  // Require at least 2 columns (i.e. at least 2 pipes or leading pipe + inner pipe)
  const pipeCount = (t.match(/\|/g) || []).length;
  return pipeCount >= 2;
}

export function inferDataTableSemantics(
  headers: string[],
  rows: string[][],
  explicitVariant?: unknown,
  explicitStemCol?: unknown,
  title?: string,
  legend?: string
): { variant: DataTableVariant; stemColIndex?: number } {
  const headerStemIdx = headers.findIndex((h) =>
    /^(?:الساق|ساق|stem)$/i.test(h.trim()) || /(?:^|\s)الساق(?:\s|$)/.test(h.trim())
  );

  let stemColIndex: number | undefined;
  if (typeof explicitStemCol === 'number' && Number.isInteger(explicitStemCol) && explicitStemCol >= 0) {
    stemColIndex = explicitStemCol;
  } else if (headerStemIdx >= 0) {
    stemColIndex = headerStemIdx;
  }

  const rawVar = String(explicitVariant ?? '').trim().toLowerCase();
  if (rawVar === 'stemleaf' || rawVar === 'stem_leaf' || rawVar === 'stem-leaf' || rawVar === 'ساق_وورقة') {
    return {
      variant: 'stemLeaf',
      ...(stemColIndex !== undefined ? { stemColIndex } : { stemColIndex: headers.length === 3 ? 1 : 0 }),
    };
  }
  if (rawVar === 'frequency' || rawVar === 'تكراري' || rawVar === 'إحصائي') {
    return { variant: 'frequency' };
  }

  const combinedMeta = `${title ?? ''} ${legend ?? ''} ${headers.join(' ')}`;
  if (
    headerStemIdx >= 0 ||
    /الساق\s*و\s*الورق|الأوراق|الورقة/.test(combinedMeta) ||
    (rows.length >= 2 && /مفتاح\s*:/.test(combinedMeta) && headers.length >= 2 && headers.length <= 3)
  ) {
    return {
      variant: 'stemLeaf',
      ...(stemColIndex !== undefined ? { stemColIndex } : {}),
    };
  }

  if (/التكرار|تكرار|الفئة|الفئات|الوزن|الدرجة|الاحتمال|النسبة/.test(combinedMeta)) {
    return { variant: 'frequency' };
  }

  return { variant: 'default' };
}

function buildTableFromRaw(headers: string[], rawRows: string[][]): QuestionDataTable {
  const colCount = Math.max(headers.length, ...rawRows.map((r) => r.length), 1);
  const normHeaders = Array.from({ length: colCount }, (_, i) => headers[i] ?? '');
  const normRows = rawRows.map((r) => Array.from({ length: colCount }, (_, i) => r[i] ?? ''));
  const hasHeaderRow = normHeaders.some((h) => h.trim().length > 0);
  const sem = inferDataTableSemantics(normHeaders, normRows);
  return {
    hasHeaderRow,
    headers: normHeaders,
    rows: normRows,
    ...(sem.variant !== 'default' ? { variant: sem.variant } : {}),
    ...(sem.stemColIndex !== undefined ? { stemColIndex: sem.stemColIndex } : {}),
  };
}

/**
 * يقسم النص إلى فقرات نصية وجداول Markdown منظمة.
 * يدعم الجداول القياسية بسطر فواصل (`|---|---|`) وكذلك الجداول المباشرة بدون سطر فواصل
 * متى توالى سطران أو أكثر تبدأ بـ `|` ولها عمودان على الأقل.
 */
export function parseMarkdownTextBlocks(input: string): MarkdownTextBlock[] {
  if (!input || !input.includes('|')) {
    return input ? [{ kind: 'text', text: input }] : [];
  }

  const lines = input.split('\n');
  const blocks: MarkdownTextBlock[] = [];
  let textBuf: string[] = [];
  let i = 0;

  const flushText = () => {
    const joined = textBuf.join('\n').trim();
    if (joined) blocks.push({ kind: 'text', text: joined });
    textBuf = [];
  };

  while (i < lines.length) {
    const cur = lines[i] ?? '';
    const next = lines[i + 1] ?? '';

    // Case 1: Standard Markdown table with |---|---| divider row
    if (cur.includes('|') && next.includes('|') && isMarkdownDividerRow(next)) {
      const headers = splitMarkdownPipeCells(cur);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim().length > 0) {
        if (!isMarkdownDividerRow(lines[j])) {
          rows.push(splitMarkdownPipeCells(lines[j]));
        }
        j++;
      }
      if (headers.length >= 2 && rows.length >= 1) {
        flushText();
        blocks.push({ kind: 'table', table: buildTableFromRaw(headers, rows) });
        i = j;
        continue;
      }
    }

    // Case 2: Dividerless pipe table (2+ consecutive | ... | lines with >= 2 columns)
    if (isPipeTableLine(cur) && isPipeTableLine(next)) {
      const headers = splitMarkdownPipeCells(cur);
      if (headers.length >= 2) {
        const rows: string[][] = [];
        let j = i + 1;
        while (j < lines.length && isPipeTableLine(lines[j])) {
          if (isMarkdownDividerRow(lines[j])) {
            j++;
            continue;
          }
          const cells = splitMarkdownPipeCells(lines[j]);
          if (cells.length >= 2) {
            rows.push(cells);
            j++;
          } else {
            break;
          }
        }
        if (rows.length >= 1) {
          flushText();
          blocks.push({ kind: 'table', table: buildTableFromRaw(headers, rows) });
          i = j;
          continue;
        }
      }
    }

    textBuf.push(cur);
    i++;
  }

  flushText();
  return blocks;
}

/** يحاول استخراج جدول معطيات واحد من نص Markdown (سواء بفاصل --- أو بدونه). */
export function parseSingleMarkdownTable(input: string): QuestionDataTable | null {
  const trimmed = String(input ?? '').trim();
  if (!trimmed.includes('|')) return null;

  const blocks = parseMarkdownTextBlocks(trimmed);
  const firstTable = blocks.find((b) => b.kind === 'table');
  if (firstTable && firstTable.kind === 'table') {
    const t = { ...firstTable.table };
    // Try extracting optional title / legend from accompanying short prose lines
    const extraText = blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (extraText) {
      const keyMatch = /(?:مفتاح(?:\s+القراءة|\s+التمثيل)?\s*[:：]\s*([^\n]+))/i.exec(extraText);
      if (keyMatch && keyMatch[1]) {
        t.legend = keyMatch[1].trim().slice(0, 200);
      }
    }
    return t;
  }

  // Fallback for single-separator pipe rows without outer | ... |
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('|') && !isMarkdownDividerRow(l));
  if (lines.length >= 2) {
    const parsedRows = lines.map(splitMarkdownPipeCells).filter((r) => r.length >= 2);
    if (parsedRows.length >= 2) {
      return buildTableFromRaw(parsedRows[0], parsedRows.slice(1));
    }
  }
  return null;
}
