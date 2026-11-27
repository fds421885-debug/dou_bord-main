import type {
  ExplanationComparison,
  ExplanationTable,
  MyQuiz,
  QuestionDataTable,
  QuizAttempt,
  QuizTableQuestion,
  SharedQuiz,
  StarredQuestion,
  TableCellConfig,
  TableCellInputType,
} from './types';
import { inferDataTableSemantics, parseSingleMarkdownTable } from './markdownTable';

export function unwrapRowArray(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object') {
    const o = row as Record<string, unknown>;
    if (Array.isArray(o.cells)) return o.cells;
    if (Array.isArray(o.columns)) return o.columns;
    if (Array.isArray(o.row)) return o.row;
  }
  return [];
}

export const TABLE_LIMITS = {
  maxRows: 12,
  maxCols: 8,
  title: 120,
  caption: 200,
  cellText: 240,
  cue: 40,
  expected: 240,
} as const;

export const DATA_TABLE_LIMITS = {
  maxRows: 24,
  maxCols: 10,
  title: 140,
  caption: 240,
  legend: 200,
  cellText: 240,
} as const;

export function emptyTableCell(value = ''): TableCellConfig {
  return {
    value,
    isBlank: false,
    inputType: 'text',
    cue: '',
    expectedAnswer: '',
  };
}

export function createDefaultTableQuestion(rowsCount = 3, colsCount = 3): QuizTableQuestion {
  const headers = Array.from({ length: colsCount }, (_, c) => `العمود ${c + 1}`);
  const rows: TableCellConfig[][] = Array.from({ length: rowsCount }, () =>
    Array.from({ length: colsCount }, () => emptyTableCell(''))
  );
  return {
    title: '',
    caption: '',
    hasHeaderRow: true,
    headers,
    rows,
  };
}

export function cellKey(rowIndex: number, colIndex: number): string {
  return `${rowIndex}_${colIndex}`;
}

export function normalizeArabicDigits(raw: string): string {
  return raw
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.')
    .replace(/−/g, '-');
}

export function normalizeTableInput(raw: string, inputType: TableCellInputType = 'text'): string {
  const basic = normalizeArabicDigits(String(raw ?? ''))
    .trim()
    .replace(/\s+/g, ' ');
  if (inputType === 'number') {
    return basic
      .replace(/,/g, '.')
      .replace(/[٪%]/g, '%')
      .replace(/\s+/g, '');
  }
  return basic
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

export function isTableCellAnswerCorrect(
  cell: TableCellConfig,
  rawStudentValue: string | undefined
): boolean {
  if (!cell.isBlank) return true;
  const studentRaw = String(rawStudentValue ?? '').trim();
  if (!studentRaw) return false;

  const inputType: TableCellInputType = cell.inputType === 'number' ? 'number' : 'text';
  const expectedVariants = String(cell.expectedAnswer ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);
  if (expectedVariants.length === 0) return false;

  const normStudent = normalizeTableInput(studentRaw, inputType);

  for (const variant of expectedVariants) {
    const normExpected = normalizeTableInput(variant, inputType);
    if (normStudent === normExpected) return true;
    if (inputType === 'number') {
      const sNum = Number(normStudent.replace(/%$/, ''));
      const eNum = Number(normExpected.replace(/%$/, ''));
      const bothPercent = normStudent.endsWith('%') === normExpected.endsWith('%');
      if (
        bothPercent &&
        Number.isFinite(sNum) &&
        Number.isFinite(eNum) &&
        Math.abs(sNum - eNum) < 1e-6
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface TableGradeResult {
  totalBlanks: number;
  answeredBlanks: number;
  correctBlanks: number;
  isFullyAnswered: boolean;
  isAllCorrect: boolean;
}

export function gradeTableQuestion(
  table: QuizTableQuestion | undefined,
  studentCellMap: Record<string, string> | undefined
): TableGradeResult {
  if (!table || !Array.isArray(table.rows)) {
    return {
      totalBlanks: 0,
      answeredBlanks: 0,
      correctBlanks: 0,
      isFullyAnswered: false,
      isAllCorrect: false,
    };
  }
  let totalBlanks = 0;
  let answeredBlanks = 0;
  let correctBlanks = 0;

  table.rows.forEach((rawRow, r) => {
    const row = unwrapRowArray(rawRow) as TableCellConfig[];
    row.forEach((cell, c) => {
      if (!cell?.isBlank) return;
      totalBlanks++;
      const val = String(studentCellMap?.[cellKey(r, c)] ?? '').trim();
      if (val.length > 0) answeredBlanks++;
      if (isTableCellAnswerCorrect(cell, val)) correctBlanks++;
    });
  });

  return {
    totalBlanks,
    answeredBlanks,
    correctBlanks,
    isFullyAnswered: totalBlanks > 0 && answeredBlanks === totalBlanks,
    isAllCorrect: totalBlanks > 0 && correctBlanks === totalBlanks,
  };
}

export function sanitizeTableCell(raw: unknown): TableCellConfig {
  if (typeof raw === 'string' || typeof raw === 'number') {
    return emptyTableCell(String(raw).trim().slice(0, TABLE_LIMITS.cellText));
  }
  if (!raw || typeof raw !== 'object') {
    return emptyTableCell('');
  }
  const o = raw as Record<string, unknown>;
  const isBlank = Boolean(o.isBlank ?? o.blank ?? false);
  const rawInputType = String(o.inputType ?? o.answerType ?? o.type ?? 'text').toLowerCase();
  const inputType: TableCellInputType =
    rawInputType === 'number' || rawInputType === 'num' || rawInputType === 'numeric' || rawInputType === 'رقم'
      ? 'number'
      : 'text';
  const expectedAnswer = String(
    o.expectedAnswer ?? o.answer ?? o.correct ?? o.correctAnswer ?? ''
  )
    .trim()
    .slice(0, TABLE_LIMITS.expected);
  const cue = String(o.cue ?? o.symbol ?? o.label ?? o.placeholder ?? '')
    .trim()
    .slice(0, TABLE_LIMITS.cue);
  const value = String(o.value ?? o.text ?? '')
    .trim()
    .slice(0, TABLE_LIMITS.cellText);

  if (isBlank) {
    return {
      value,
      isBlank: true,
      inputType,
      ...(cue ? { cue } : {}),
      expectedAnswer: expectedAnswer || value,
    };
  }

  return {
    value,
    isBlank: false,
  };
}

export function sanitizeTableQuestion(raw: unknown): QuizTableQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rawRows = Array.isArray(o.rows) ? o.rows : [];
  if (rawRows.length === 0) return null;

  const cleanRowsInput = rawRows.slice(0, TABLE_LIMITS.maxRows);
  const rawHeaders = Array.isArray(o.headers)
    ? o.headers.slice(0, TABLE_LIMITS.maxCols).map((h) => String(h ?? '').trim().slice(0, TABLE_LIMITS.cellText))
    : undefined;

  let colCount = rawHeaders?.length ?? 0;
  for (const r of cleanRowsInput) {
    const arr = unwrapRowArray(r);
    if (arr.length > 0) {
      colCount = Math.max(colCount, Math.min(TABLE_LIMITS.maxCols, arr.length));
    }
  }
  if (colCount === 0) return null;

  const rows: TableCellConfig[][] = cleanRowsInput.map((r) => {
    const arr = unwrapRowArray(r);
    const out: TableCellConfig[] = [];
    for (let c = 0; c < colCount; c++) {
      out.push(sanitizeTableCell(arr[c]));
    }
    return out;
  });

  const hasHeaderRow =
    typeof o.hasHeaderRow === 'boolean'
      ? o.hasHeaderRow
      : Boolean(rawHeaders && rawHeaders.some((h) => h.length > 0));

  const headers = hasHeaderRow
    ? Array.from({ length: colCount }, (_, c) => rawHeaders?.[c] ?? '')
    : undefined;

  const title = typeof o.title === 'string' ? o.title.trim().slice(0, TABLE_LIMITS.title) : '';
  const caption = typeof o.caption === 'string' ? o.caption.trim().slice(0, TABLE_LIMITS.caption) : '';

  return {
    ...(title ? { title } : {}),
    ...(caption ? { caption } : {}),
    hasHeaderRow,
    ...(headers ? { headers } : {}),
    rows,
  };
}

export function parseTableQuestion(raw: unknown): {
  table: QuizTableQuestion | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    warnings.push('بيانات الجدول ليست كائناً صالحاً.');
    return { table: null, warnings };
  }
  const table = sanitizeTableQuestion(raw);
  if (!table) {
    warnings.push('الجدول فارغ أو بلا صفوف صالحة.');
    return { table: null, warnings };
  }
  const blanks = table.rows.flat().filter((c) => c.isBlank);
  if (blanks.length === 0) {
    warnings.push('لا يحتوي الجدول على أي خلية فراغ (isBlank: true) ليملأها الطالب.');
  } else if (blanks.some((b) => !String(b.expectedAnswer ?? '').trim())) {
    warnings.push('توجد خلية فراغ في الجدول بدون إجابة متوقعة (expectedAnswer).');
  }
  return { table, warnings };
}

export function tableQuestionProblem(table: QuizTableQuestion | undefined): string | null {
  if (!table || typeof table !== 'object' || !Array.isArray(table.rows) || table.rows.length === 0) {
    return 'أضف صفاً واحداً على الأقل في الجدول.';
  }
  const normalizedRows = table.rows.map((r) => unwrapRowArray(r));
  const blanks = normalizedRows
    .flat()
    .filter((c): c is TableCellConfig => Boolean(c && typeof c === 'object' && (c as TableCellConfig).isBlank));
  if (blanks.length === 0) {
    return 'حدد خلية واحدة على الأقل كـ «فراغ للطالب» داخل الجدول.';
  }
  for (let r = 0; r < normalizedRows.length; r++) {
    const row = normalizedRows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c] as TableCellConfig | undefined;
      if (cell?.isBlank && !String(cell.expectedAnswer ?? '').trim()) {
        return `الفراغ في الصف ${r + 1} العمود ${c + 1} بدون إجابة صحيحة متوقعة.`;
      }
    }
  }
  return null;
}

export function sanitizeExplanationTable(raw: unknown): ExplanationTable | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rawRows = Array.isArray(o.rows) ? o.rows.slice(0, 10) : [];
  const rawHeaders = Array.isArray(o.headers)
    ? o.headers.slice(0, 8).map((h) => String(h ?? '').trim().slice(0, 160))
    : [];
  const colCount = Math.max(
    rawHeaders.length,
    ...rawRows.map((r) => Math.min(8, unwrapRowArray(r).length))
  );
  if (colCount === 0 || (rawHeaders.length === 0 && rawRows.length === 0)) return null;

  const headers = Array.from({ length: colCount }, (_, c) => rawHeaders[c] ?? '');
  const rows = rawRows.map((r) => {
    const arr = unwrapRowArray(r);
    return Array.from({ length: colCount }, (_, c) => String(arr[c] ?? '').trim().slice(0, 240));
  });
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';
  return {
    ...(title ? { title } : {}),
    headers,
    rows,
  };
}

export function sanitizeExplanationComparison(raw: unknown): ExplanationComparison | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const firstLabel = String(o.firstLabel ?? o.leftLabel ?? 'القيمة الأولى').trim().slice(0, 100);
  const firstValue = String(o.firstValue ?? o.leftValue ?? '').trim().slice(0, 300);
  const secondLabel = String(o.secondLabel ?? o.rightLabel ?? 'القيمة الثانية').trim().slice(0, 100);
  const secondValue = String(o.secondValue ?? o.rightValue ?? '').trim().slice(0, 300);
  const verdict = String(o.verdict ?? o.result ?? '').trim().slice(0, 200);
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';
  if (!firstValue && !secondValue) return null;
  return {
    ...(title ? { title } : {}),
    firstLabel: firstLabel || 'القيمة الأولى',
    firstValue,
    secondLabel: secondLabel || 'القيمة الثانية',
    secondValue,
    ...(verdict ? { verdict } : {}),
  };
}

function extractDataCellText(cell: unknown): string {
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell).trim().slice(0, DATA_TABLE_LIMITS.cellText);
  }
  if (cell && typeof cell === 'object') {
    const o = cell as Record<string, unknown>;
    const raw = o.value ?? o.text ?? o.label ?? o.expectedAnswer ?? '';
    return String(raw).trim().slice(0, DATA_TABLE_LIMITS.cellText);
  }
  return '';
}

export function sanitizeDataTable(raw: unknown): QuestionDataTable | null {
  if (typeof raw === 'string') {
    const parsedMd = parseSingleMarkdownTable(raw);
    return parsedMd ? sanitizeDataTable(parsedMd) : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const rawRowsSource = Array.isArray(o.rows)
    ? o.rows
    : Array.isArray(o.data)
    ? o.data
    : Array.isArray(o.body)
    ? o.body
    : [];
  const rawRows = rawRowsSource.slice(0, DATA_TABLE_LIMITS.maxRows);

  const rawHeadersSource = Array.isArray(o.headers)
    ? o.headers
    : Array.isArray(o.columns)
    ? o.columns
    : Array.isArray(o.cols)
    ? o.cols
    : [];
  const rawHeaders = rawHeadersSource
    .slice(0, DATA_TABLE_LIMITS.maxCols)
    .map((h) => extractDataCellText(h));

  let colCount = rawHeaders.length;
  for (const r of rawRows) {
    const arr = unwrapRowArray(r);
    if (arr.length > 0) {
      colCount = Math.max(colCount, Math.min(DATA_TABLE_LIMITS.maxCols, arr.length));
    }
  }
  if (colCount === 0 || rawRows.length === 0) return null;

  const headers = Array.from({ length: colCount }, (_, c) => rawHeaders[c] ?? '');
  const rows = rawRows.map((r) => {
    const arr = unwrapRowArray(r);
    return Array.from({ length: colCount }, (_, c) => extractDataCellText(arr[c]));
  });

  const title = typeof o.title === 'string' ? o.title.trim().slice(0, DATA_TABLE_LIMITS.title) : '';
  const caption = typeof o.caption === 'string' ? o.caption.trim().slice(0, DATA_TABLE_LIMITS.caption) : '';
  const rawLegend = o.legend ?? o.key ?? o.tableKey ?? o['مفتاح'] ?? o['المفتاح'] ?? '';
  const legend =
    typeof rawLegend === 'string' ? rawLegend.trim().slice(0, DATA_TABLE_LIMITS.legend) : '';
  const hasHeaderRow =
    typeof o.hasHeaderRow === 'boolean'
      ? o.hasHeaderRow
      : headers.some((h) => h.trim().length > 0);

  const sem = inferDataTableSemantics(
    headers,
    rows,
    o.variant ?? o.kind ?? o.tableType ?? o['النوع'],
    typeof o.stemColIndex === 'number' ? o.stemColIndex : undefined,
    title,
    legend
  );

  return {
    ...(title ? { title } : {}),
    ...(caption ? { caption } : {}),
    ...(legend ? { legend } : {}),
    ...(sem.variant !== 'default' ? { variant: sem.variant } : {}),
    ...(sem.stemColIndex !== undefined && sem.stemColIndex < colCount
      ? { stemColIndex: sem.stemColIndex }
      : {}),
    hasHeaderRow,
    headers,
    rows,
  };
}

export function createDefaultDataTable(
  preset: 'normal' | 'stemLeafSingle' | 'stemLeafDouble' = 'normal'
): QuestionDataTable {
  if (preset === 'stemLeafSingle') {
    return {
      title: 'تمثيل البيانات بالساق والورقة',
      legend: 'مفتاح: 3|8 = 38',
      variant: 'stemLeaf',
      stemColIndex: 0,
      hasHeaderRow: true,
      headers: ['الساق', 'الأوراق'],
      rows: [
        ['3', '8 9'],
        ['4', '1 3 4 5 7'],
        ['5', '0 1 2'],
      ],
    };
  }
  if (preset === 'stemLeafDouble') {
    return {
      title: 'تمثيل الساق والورقة المزدوج للأوزان (كجم)',
      legend: '8∣3 = 38 ، و 3∣9 = 39',
      variant: 'stemLeaf',
      stemColIndex: 1,
      hasHeaderRow: true,
      headers: ['6/ب (الأوراق)', 'الساق', '6/أ (الأوراق)'],
      rows: [
        ['9 9 9', '3', '8 9'],
        ['6 6 4 2 2 2', '4', '1 3 4 4 5 7 9'],
        ['5 2 1 1 1', '5', '0 1 2 3'],
        ['3 0', '6', '0 0'],
      ],
    };
  }
  return {
    title: 'جدول معطيات السؤال',
    hasHeaderRow: true,
    headers: ['الفئة', 'التكرار'],
    rows: [
      ['الأولى', '12'],
      ['الثانية', '18'],
      ['الثالثة', '10'],
    ],
  };
}

export function hasInteractiveTableBlanks(table: QuizTableQuestion | null | undefined): boolean {
  if (!table || !Array.isArray(table.rows)) return false;
  return table.rows.some((rawRow) =>
    unwrapRowArray(rawRow).some((c) => Boolean(c && typeof c === 'object' && (c as TableCellConfig).isBlank))
  );
}

export function interactiveTableToDataTable(
  table: QuizTableQuestion | null | undefined
): QuestionDataTable | null {
  if (!table || !Array.isArray(table.rows) || table.rows.length === 0) return null;
  const rows = table.rows.map((rawRow) =>
    unwrapRowArray(rawRow).map((c) => extractDataCellText(c))
  );
  return sanitizeDataTable({
    ...(table.title ? { title: table.title } : {}),
    ...(table.caption ? { caption: table.caption } : {}),
    hasHeaderRow: table.hasHeaderRow,
    headers: table.headers ?? [],
    rows,
  });
}

export function dataTableProblem(dt: QuestionDataTable | undefined): string | null {
  if (!dt || typeof dt !== 'object' || !Array.isArray(dt.rows) || dt.rows.length === 0) {
    return 'أضف صفاً واحداً على الأقل في جدول المعطيات.';
  }
  const clean = sanitizeDataTable(dt);
  if (!clean) return 'جدول المعطيات غير صالح.';
  const hasAnyCell = clean.rows.some((r) => r.some((c) => c.trim().length > 0));
  if (!hasAnyCell) return 'املأ خلية واحدة على الأقل في جدول المعطيات.';
  return null;
}

/* ------------------------------------------------------------------ */
/*  تشفير وفك الجداول لقاعدة Firestore (لا تدعم مصفوفات داخل مصفوفات) */
/* ------------------------------------------------------------------ */

export function encodeTableForFirestore(rawTable: unknown): Record<string, unknown> | null {
  const clean = sanitizeTableQuestion(rawTable);
  if (!clean) return null;
  return {
    ...(clean.title ? { title: clean.title } : {}),
    ...(clean.caption ? { caption: clean.caption } : {}),
    hasHeaderRow: Boolean(clean.hasHeaderRow),
    ...(clean.headers ? { headers: clean.headers } : {}),
    rows: clean.rows.map((cells) => ({ cells })),
  };
}

export function encodeExplanationTableForFirestore(
  rawExpTable: unknown
): Record<string, unknown> | null {
  const clean = sanitizeExplanationTable(rawExpTable);
  if (!clean) return null;
  return {
    ...(clean.title ? { title: clean.title } : {}),
    headers: clean.headers,
    rows: clean.rows.map((cells) => ({ cells })),
  };
}

export function encodeDataTableForFirestore(
  rawDataTable: unknown
): Record<string, unknown> | null {
  const clean = sanitizeDataTable(rawDataTable);
  if (!clean) return null;
  return {
    ...(clean.title ? { title: clean.title } : {}),
    ...(clean.caption ? { caption: clean.caption } : {}),
    ...(clean.legend ? { legend: clean.legend } : {}),
    ...(clean.variant && clean.variant !== 'default' ? { variant: clean.variant } : {}),
    ...(typeof clean.stemColIndex === 'number' ? { stemColIndex: clean.stemColIndex } : {}),
    hasHeaderRow: Boolean(clean.hasHeaderRow),
    headers: clean.headers,
    rows: clean.rows.map((cells) => ({ cells })),
  };
}

export function encodeQuestionFieldsForFirestore<T extends Record<string, unknown>>(q: T): T {
  const out: Record<string, unknown> = { ...q };
  if ('table' in out) {
    const encodedTable = out.table ? encodeTableForFirestore(out.table) : null;
    if (encodedTable) out.table = encodedTable;
    else delete out.table;
  }
  if ('dataTable' in out) {
    const encodedDataTable = out.dataTable ? encodeDataTableForFirestore(out.dataTable) : null;
    if (encodedDataTable) out.dataTable = encodedDataTable;
    else delete out.dataTable;
  }
  if ('explanationTable' in out) {
    const encodedExp = out.explanationTable
      ? encodeExplanationTableForFirestore(out.explanationTable)
      : null;
    if (encodedExp) out.explanationTable = encodedExp;
    else delete out.explanationTable;
  }
  return out as T;
}

export function sanitizeQuestionLaws(raw: unknown): string[] | null {
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    items = raw.split(/\r?\n/);
  } else {
    return null;
  }
  const out: string[] = [];
  for (const item of items) {
    let text = '';
    if (typeof item === 'string' || typeof item === 'number') {
      text = String(item);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const v = o.law ?? o.rule ?? o.formula ?? o.text ?? o.title ?? o.name ?? '';
      if (typeof v === 'string' || typeof v === 'number') text = String(v);
    }
    const clean = text.trim().slice(0, 400);
    if (clean) out.push(clean);
  }
  return out.length > 0 ? out : null;
}

function coerceFieldString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function decodeQuizQuestionFromFirestore<T extends Record<string, unknown>>(q: T): T {
  if (!q || typeof q !== 'object') return q;
  let changed = false;
  const out: Record<string, unknown> = { ...q };

  if (typeof out.text !== 'string') {
    out.text = coerceFieldString(out.text, '');
    changed = true;
  }
  if ('explanation' in out && typeof out.explanation !== 'string') {
    out.explanation = coerceFieldString(out.explanation, '');
    changed = true;
  }
  if ('answer' in out && typeof out.answer !== 'string') {
    out.answer = coerceFieldString(out.answer, '');
    changed = true;
  }
  if (Array.isArray(out.choices)) {
    const needsChoiceCoercion = out.choices.some((c) => typeof c !== 'string');
    if (needsChoiceCoercion) {
      out.choices = out.choices.map((c) => coerceFieldString(c, ''));
      changed = true;
    }
  } else {
    out.choices = [];
    changed = true;
  }

  if ('laws' in out) {
    const cleanLaws = sanitizeQuestionLaws(out.laws);
    if (cleanLaws) {
      out.laws = cleanLaws;
      changed = true;
    } else {
      delete out.laws;
      changed = true;
    }
  }
  if (out.table) {
    const decoded = sanitizeTableQuestion(out.table);
    if (decoded) {
      out.table = decoded;
      changed = true;
    } else {
      delete out.table;
      changed = true;
    }
  }
  if (out.dataTable) {
    const decodedData = sanitizeDataTable(out.dataTable);
    if (decodedData) {
      out.dataTable = decodedData;
      changed = true;
    } else {
      delete out.dataTable;
      changed = true;
    }
  }
  if (out.explanationTable) {
    const decodedExp = sanitizeExplanationTable(out.explanationTable);
    if (decodedExp) {
      out.explanationTable = decodedExp;
      changed = true;
    } else {
      delete out.explanationTable;
      changed = true;
    }
  }
  return (changed ? out : q) as T;
}

export function decodeMyQuizFromFirestore(quiz: MyQuiz): MyQuiz {
  if (!quiz || typeof quiz !== 'object') return quiz;
  const rawQuestions = Array.isArray(quiz.questions) ? quiz.questions : [];
  const decodedQuestions = rawQuestions
    .filter((q): q is MyQuiz['questions'][number] => Boolean(q && typeof q === 'object'))
    .map((q) =>
      decodeQuizQuestionFromFirestore(q as unknown as Record<string, unknown>) as unknown as MyQuiz['questions'][number]
    );
  return {
    ...quiz,
    title: coerceFieldString((quiz as { title?: unknown }).title, 'اختبار'),
    questions: decodedQuestions,
    questionCount:
      typeof quiz.questionCount === 'number' && Number.isFinite(quiz.questionCount)
        ? quiz.questionCount
        : decodedQuestions.length,
  };
}

export function decodeSharedQuizFromFirestore(quiz: SharedQuiz): SharedQuiz {
  if (!quiz || typeof quiz !== 'object') return quiz;
  const rawQuestions = Array.isArray(quiz.questions) ? quiz.questions : [];
  return {
    ...quiz,
    title: coerceFieldString((quiz as { title?: unknown }).title, 'اختبار'),
    questions: rawQuestions
      .filter((q): q is SharedQuiz['questions'][number] => Boolean(q && typeof q === 'object'))
      .map((q) =>
        decodeQuizQuestionFromFirestore(q as unknown as Record<string, unknown>) as unknown as SharedQuiz['questions'][number]
      ),
  };
}

export function decodeExamAttemptFromFirestore(attempt: QuizAttempt): QuizAttempt {
  if (!attempt || typeof attempt !== 'object') return attempt;
  const rawQuestions = Array.isArray(attempt.questions) ? attempt.questions : [];
  const decodedQuestions = rawQuestions
    .filter((q): q is QuizAttempt['questions'][number] => Boolean(q && typeof q === 'object'))
    .map((q) =>
      decodeQuizQuestionFromFirestore(q as unknown as Record<string, unknown>) as unknown as QuizAttempt['questions'][number]
    );
  return {
    ...attempt,
    title: coerceFieldString((attempt as { title?: unknown }).title, 'اختبار سابق'),
    questions: decodedQuestions,
    answers: Array.isArray(attempt.answers) ? attempt.answers : [],
    score: Number.isFinite(Number(attempt.score)) ? Number(attempt.score) : 0,
    total: Number.isFinite(Number(attempt.total)) ? Number(attempt.total) : decodedQuestions.length,
    durationSec: Number.isFinite(Number(attempt.durationSec)) ? Number(attempt.durationSec) : 0,
    finishedAt: Number.isFinite(Number(attempt.finishedAt)) ? Number(attempt.finishedAt) : 0,
  };
}

export function decodeStarredQuestionFromFirestore(item: StarredQuestion): StarredQuestion {
  if (!item || typeof item !== 'object' || !item.question || typeof item.question !== 'object') return item;
  return {
    ...item,
    question: decodeQuizQuestionFromFirestore(
      item.question as unknown as Record<string, unknown>
    ) as unknown as StarredQuestion['question'],
  };
}
