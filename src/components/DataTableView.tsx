import React, { useState } from 'react';
import { ClipboardPaste, KeyRound, Plus, Table2, Trash2, X } from 'lucide-react';
import type { DataTableVariant, QuestionDataTable } from '../types';
import { MathSpan } from '../mathSpan';
import { parseSingleMarkdownTable } from '../markdownTable';
import {
  createDefaultDataTable,
  DATA_TABLE_LIMITS,
  sanitizeDataTable,
} from '../quizTable';

interface ViewProps {
  table: QuestionDataTable;
  className?: string;
  compact?: boolean;
}

function isPureNumericLeafSequence(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  return /^[0-9\u0660-\u0669\u06F0-\u06F9\s.,\-+/|∣]+$/.test(t);
}

export const DataTableView: React.FC<ViewProps> = ({ table, className, compact }) => {
  const clean = sanitizeDataTable(table);
  if (!clean) return null;

  const isStemLeaf = clean.variant === 'stemLeaf';
  const colCount = Math.max(clean.headers.length, ...clean.rows.map((r) => r.length), 1);
  const stemCol =
    isStemLeaf &&
    typeof clean.stemColIndex === 'number' &&
    clean.stemColIndex >= 0 &&
    clean.stemColIndex < colCount
      ? clean.stemColIndex
      : isStemLeaf
      ? clean.headers.findIndex((h) => /^(?:الساق|ساق|stem)$/i.test(h.trim()) || /الساق/.test(h))
      : -1;

  const padCell = compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2.5';

  return (
    <div className={`flex flex-col gap-1.5 w-full ${className ?? ''}`} dir="rtl">
      {clean.title && (
        <div className="flex items-center gap-1.5 text-xs font-black text-[#0E6BA8]">
          <Table2 className="w-4 h-4 shrink-0" />
          <MathSpan text={clean.title} inline />
        </div>
      )}

      {clean.legend && (
        <div className="flex items-center gap-2 rounded-xl border border-[#BCE3FA] bg-[#F2FAFF] px-3 py-1.5 text-xs font-extrabold text-[#0B4F7A]">
          <KeyRound className="w-3.5 h-3.5 shrink-0 text-[#1899D6]" />
          <span className="shrink-0 font-black">مفتاح الجدول:</span>
          <span dir="auto" className="font-bold tabular-nums">
            <MathSpan text={clean.legend} inline />
          </span>
        </div>
      )}

      <div className="w-full overflow-x-auto rounded-2xl border-2 border-[#CBE9FA] bg-white">
        <table
          className={`w-full border-collapse tabular-nums ${
            compact ? 'text-xs' : 'text-xs sm:text-sm'
          }`}
        >
          {clean.hasHeaderRow !== false && clean.headers.some((h) => h.trim().length > 0) && (
            <thead>
              <tr className="bg-[#E1F3FF] border-b-2 border-[#A8DBFA]">
                {Array.from({ length: colCount }, (_, c) => {
                  const isStem = isStemLeaf && c === stemCol;
                  let alignClass = 'text-right';
                  if (isStem) alignClass = 'text-center';
                  else if (isStemLeaf && stemCol >= 0) {
                    alignClass = c < stemCol ? 'text-left' : 'text-right';
                  }
                  return (
                    <th
                      key={c}
                      className={`${padCell} ${alignClass} font-black border-l last:border-l-0 border-[#BCE3FA] whitespace-nowrap ${
                        isStem
                          ? 'bg-[#CBE9FA] text-[#0A466D] border-x-2 border-x-[#63BDF2] w-[1%] px-4'
                          : 'text-[#0E6BA8]'
                      }`}
                    >
                      <MathSpan text={clean.headers[c] ?? ''} inline />
                    </th>
                  );
                })}
              </tr>
            </thead>
          )}
          <tbody>
            {clean.rows.map((row, ri) => (
              <tr
                key={ri}
                className="border-b last:border-b-0 border-[#E5E5E5] odd:bg-white even:bg-[#F9FCFF]"
              >
                {Array.from({ length: colCount }, (_, ci) => {
                  const rawCell = row[ci] ?? '';
                  const isStem = isStemLeaf && ci === stemCol;
                  const numericSeq = isPureNumericLeafSequence(rawCell);

                  let alignClass = 'text-right';
                  if (isStem) alignClass = 'text-center';
                  else if (isStemLeaf && stemCol >= 0) {
                    alignClass = ci < stemCol ? 'text-left' : 'text-right';
                  }

                  return (
                    <td
                      key={ci}
                      dir={numericSeq ? 'ltr' : 'auto'}
                      className={`${padCell} ${alignClass} border-l last:border-l-0 border-[#E5E5E5] align-middle ${
                        isStem
                          ? 'bg-[#EFF8FF] font-black text-[#0B4F7A] border-x-2 border-x-[#63BDF2] whitespace-nowrap'
                          : isStemLeaf
                          ? 'font-extrabold text-[#2C3E50] tracking-wider'
                          : 'font-bold text-[#3C3C3C]'
                      }`}
                    >
                      {rawCell ? (
                        <MathSpan text={rawCell} inline />
                      ) : (
                        <span className="text-[#AFAFAF]">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {clean.caption && (
        <p className="text-[11px] font-bold text-[#666666]">
          <MathSpan text={clean.caption} inline />
        </p>
      )}
    </div>
  );
};

/* ---------------- محرر جدول المعطيات (استخراج المعلومات والساق والورقة) ---------------- */

interface EditorProps {
  dataTable: QuestionDataTable | undefined;
  onChange: (next: QuestionDataTable | undefined) => void;
}

export const QuizDataTableEditor: React.FC<EditorProps> = ({ dataTable, onChange }) => {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);

  if (!dataTable) {
    return (
      <button
        type="button"
        onClick={() => onChange(createDefaultDataTable('normal'))}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-2xl border-2 border-[#CBE9FA] bg-[#F2FAFF] hover:border-[#1CB0F6] text-xs font-black text-[#0E6BA8] cursor-pointer"
      >
        <Table2 className="w-4 h-4 shrink-0" />
        <span>إضافة جدول معطيات / ساق وورقة</span>
      </button>
    );
  }

  const colCount = Math.max(
    dataTable.headers?.length ?? 0,
    ...(dataTable.rows || []).map((r) => r.length),
    1
  );

  const patch = (partial: Partial<QuestionDataTable>) =>
    onChange({
      ...dataTable,
      ...partial,
    });

  const updateHeader = (c: number, value: string) => {
    const nextHeaders = Array.from({ length: colCount }, (_, i) => dataTable.headers?.[i] ?? '');
    nextHeaders[c] = value;
    const stemIdx = nextHeaders.findIndex((h) => /^(?:الساق|ساق|stem)$/i.test(h.trim()) || /الساق/.test(h));
    patch({
      headers: nextHeaders,
      hasHeaderRow: nextHeaders.some((h) => h.trim().length > 0),
      ...(stemIdx >= 0 ? { variant: 'stemLeaf', stemColIndex: stemIdx } : {}),
    });
  };

  const updateCell = (r: number, c: number, value: string) => {
    const nextRows = dataTable.rows.map((row, ri) =>
      ri !== r
        ? row
        : Array.from({ length: colCount }, (_, ci) => (ci === c ? value : row[ci] ?? ''))
    );
    patch({ rows: nextRows });
  };

  const addRow = () => {
    if (dataTable.rows.length >= DATA_TABLE_LIMITS.maxRows) return;
    patch({ rows: [...dataTable.rows, Array.from({ length: colCount }, () => '')] });
  };

  const removeRow = (r: number) => {
    if (dataTable.rows.length <= 1) return;
    patch({ rows: dataTable.rows.filter((_, i) => i !== r) });
  };

  const addCol = () => {
    if (colCount >= DATA_TABLE_LIMITS.maxCols) return;
    const nextHeaders = [
      ...Array.from({ length: colCount }, (_, c) => dataTable.headers?.[c] ?? ''),
      `عمود ${colCount + 1}`,
    ];
    const nextRows = dataTable.rows.map((row) => [
      ...Array.from({ length: colCount }, (_, c) => row[c] ?? ''),
      '',
    ]);
    patch({ headers: nextHeaders, rows: nextRows, hasHeaderRow: true });
  };

  const removeCol = (c: number) => {
    if (colCount <= 1) return;
    const nextHeaders = Array.from({ length: colCount }, (_, i) => dataTable.headers?.[i] ?? '').filter(
      (_, i) => i !== c
    );
    const nextRows = dataTable.rows.map((row) =>
      Array.from({ length: colCount }, (_, i) => row[i] ?? '').filter((_, i) => i !== c)
    );
    patch({ headers: nextHeaders, rows: nextRows });
  };

  const applyPasteMarkdown = () => {
    const parsed = parseSingleMarkdownTable(pasteText);
    if (!parsed) {
      setPasteErr('لم أتعرف على صيغة جدول صالحة. تأكد من وجود أسطر تحتوي | بين الأعمدة.');
      return;
    }
    onChange({
      ...parsed,
      title: dataTable.title || parsed.title,
      legend: parsed.legend || dataTable.legend,
    });
    setPasteText('');
    setPasteErr(null);
    setPasteOpen(false);
  };

  return (
    <div
      className="w-full rounded-2xl border-2 border-[#1CB0F6]/55 bg-[#F2FAFF]/70 p-3.5 flex flex-col gap-3"
      dir="rtl"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-black text-[#0E6BA8]">
          <Table2 className="w-4 h-4 shrink-0" />
          <span>جدول المعطيات (للقراءة واستخراج المعلومات)</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onChange(createDefaultDataTable('normal'))}
            className="px-2.5 py-1 rounded-xl bg-white border border-[#BCE3FA] hover:border-[#1CB0F6] text-[11px] font-black text-[#0E6BA8] cursor-pointer"
          >
            قالب تكراري
          </button>
          <button
            type="button"
            onClick={() => onChange(createDefaultDataTable('stemLeafSingle'))}
            className="px-2.5 py-1 rounded-xl bg-white border border-[#BCE3FA] hover:border-[#1CB0F6] text-[11px] font-black text-[#0E6BA8] cursor-pointer"
          >
            ساق وورقة
          </button>
          <button
            type="button"
            onClick={() => onChange(createDefaultDataTable('stemLeafDouble'))}
            className="px-2.5 py-1 rounded-xl bg-white border border-[#BCE3FA] hover:border-[#1CB0F6] text-[11px] font-black text-[#0E6BA8] cursor-pointer"
          >
            ساق وورقة مزدوج
          </button>
          <button
            type="button"
            onClick={() => {
              setPasteOpen((v) => !v);
              setPasteErr(null);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border border-[#A560E8]/60 text-[11px] font-black text-[#8938D6] cursor-pointer"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            <span>لصق جدول Markdown</span>
          </button>
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[#FFDFE0] border border-[#FF4B4B]/50 text-[11px] font-black text-[#EA2B2B] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>حذف</span>
          </button>
        </div>
      </div>

      {pasteOpen && (
        <div className="rounded-xl border border-[#CE82FF] bg-white p-2.5 flex flex-col gap-2">
          <span className="text-[11px] font-black text-[#6D28D9]">
            الصق جدولاً بصيغة Markdown (مثل: | 6/ب (الأوراق) | الساق | 6/أ (الأوراق) | ...):
          </span>
          <textarea
            rows={4}
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteErr(null);
            }}
            dir="auto"
            placeholder={'| 6/ب (الأوراق) | الساق | 6/أ (الأوراق) |\n| 9 9 9 | 3 | 8 9 |\n| 6 6 4 2 2 2 | 4 | 1 3 4 4 5 7 9 |'}
            className="w-full rounded-xl border border-[#E5E5E5] p-2 text-xs font-mono outline-none focus:border-[#A560E8]"
          />
          {pasteErr && <span className="text-[11px] font-bold text-[#EA2B2B]">{pasteErr}</span>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyPasteMarkdown}
              className="px-3 py-1.5 rounded-xl bg-[#A560E8] text-white text-xs font-black cursor-pointer"
            >
              تحويل وتعبئة الجدول
            </button>
            <button
              type="button"
              onClick={() => setPasteOpen(false)}
              className="px-3 py-1.5 rounded-xl bg-[#F7F7F7] text-[#777777] text-xs font-black cursor-pointer"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          value={dataTable.title ?? ''}
          onChange={(e) => patch({ title: e.target.value })}
          maxLength={DATA_TABLE_LIMITS.title}
          placeholder="عنوان الجدول (اختياري)"
          className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] bg-white px-3 py-1.5 text-xs font-bold text-[#3C3C3C] outline-none"
        />
        <input
          type="text"
          value={dataTable.legend ?? ''}
          onChange={(e) => patch({ legend: e.target.value })}
          maxLength={DATA_TABLE_LIMITS.legend}
          placeholder="مفتاح الجدول (مثال: 8∣3 = 38 ، و 3∣9 = 39)"
          className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] bg-white px-3 py-1.5 text-xs font-bold text-[#3C3C3C] outline-none"
        />
        <div className="flex items-center gap-2">
          <select
            value={dataTable.variant ?? 'default'}
            onChange={(e) => patch({ variant: e.target.value as DataTableVariant })}
            className="flex-1 rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] bg-white px-2.5 py-1.5 text-xs font-black text-[#3C3C3C] outline-none"
          >
            <option value="default">جدول عادي</option>
            <option value="stemLeaf">تمثيل الساق والورقة</option>
            <option value="frequency">جدول تكراري / إحصائي</option>
          </select>
          <button
            type="button"
            onClick={addRow}
            disabled={dataTable.rows.length >= DATA_TABLE_LIMITS.maxRows}
            className="inline-flex items-center gap-0.5 px-2.5 py-1.5 rounded-xl bg-white border border-[#1CB0F6] text-[11px] font-black text-[#1899D6] cursor-pointer disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" /> صف
          </button>
          <button
            type="button"
            onClick={addCol}
            disabled={colCount >= DATA_TABLE_LIMITS.maxCols}
            className="inline-flex items-center gap-0.5 px-2.5 py-1.5 rounded-xl bg-white border border-[#1CB0F6] text-[11px] font-black text-[#1899D6] cursor-pointer disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" /> عمود
          </button>
        </div>
      </div>

      <div className="w-full overflow-x-auto rounded-2xl border-2 border-[#E5E5E5] bg-white">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-[#E1F3FF] border-b border-[#BCE3FA]">
              {Array.from({ length: colCount }, (_, c) => (
                <th key={c} className="p-1.5 border-l last:border-l-0 border-[#BCE3FA] min-w-[100px]">
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={dataTable.headers?.[c] ?? ''}
                      onChange={(e) => updateHeader(c, e.target.value)}
                      placeholder={`عنوان ${c + 1}`}
                      className="w-full bg-white rounded-lg border border-[#BCE3FA] px-2 py-1 text-xs font-black text-[#0E6BA8] outline-none"
                    />
                    {colCount > 1 && (
                      <button
                        type="button"
                        onClick={() => removeCol(c)}
                        title="حذف العمود"
                        className="p-1 text-[#EA2B2B] hover:bg-[#FFDFE0] rounded cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {dataTable.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-b-0 border-[#E5E5E5]">
                {Array.from({ length: colCount }, (_, c) => (
                  <td key={c} className="p-1.5 border-l border-[#E5E5E5] min-w-[100px]">
                    <input
                      type="text"
                      value={row[c] ?? ''}
                      maxLength={DATA_TABLE_LIMITS.cellText}
                      onChange={(e) => updateCell(r, c, e.target.value)}
                      dir="auto"
                      placeholder="قيمة..."
                      className="w-full rounded-lg border border-[#E5E5E5] focus:border-[#1CB0F6] px-2 py-1 text-xs font-bold text-[#3C3C3C] outline-none"
                    />
                  </td>
                ))}
                <td className="p-1 text-center">
                  {dataTable.rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeRow(r)}
                      title="حذف الصف"
                      className="p-1 text-[#EA2B2B] hover:bg-[#FFDFE0] rounded cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <input
        type="text"
        value={dataTable.caption ?? ''}
        onChange={(e) => patch({ caption: e.target.value })}
        maxLength={DATA_TABLE_LIMITS.caption}
        placeholder="ملاحظة توضيحية أسفل الجدول (اختياري)"
        className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] bg-white px-3 py-1.5 text-xs font-bold text-[#3C3C3C] outline-none"
      />

      <div className="rounded-2xl bg-white border border-[#CBE9FA] p-3 flex flex-col gap-1.5">
        <span className="text-[11px] font-black text-[#777777]">معاينة الجدول كما سيظهر للطالب:</span>
        <DataTableView table={dataTable} compact />
      </div>
    </div>
  );
};
