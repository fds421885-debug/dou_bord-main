import React, { useState } from 'react';
import { CheckCircle2, HelpCircle, Plus, Table2, Trash2, XCircle } from 'lucide-react';
import type { QuizTableQuestion, TableCellConfig, TableCellInputType } from '../types';
import { MathText } from '../mathText';
import {
  cellKey,
  createDefaultTableQuestion,
  emptyTableCell,
  isTableCellAnswerCorrect,
  TABLE_LIMITS,
} from '../quizTable';

interface ViewProps {
  table: QuizTableQuestion;
  mode: 'exam' | 'review' | 'preview';
  answers?: Record<string, string>;
  onChangeAnswer?: (key: string, value: string) => void;
}

export const QuestionTableView: React.FC<ViewProps> = ({
  table,
  mode,
  answers = {},
  onChangeAnswer,
}) => {
  const colCount = Math.max(
    table.headers?.length ?? 0,
    ...(table.rows || []).map((r) => r.length),
    1
  );

  return (
    <div className="flex flex-col gap-2 w-full" dir="rtl">
      {table.title && (
        <div className="flex items-center gap-1.5 text-xs font-black text-[#1899D6]">
          <Table2 className="w-4 h-4 shrink-0" />
          <MathText text={table.title} />
        </div>
      )}
      <div className="w-full overflow-x-auto rounded-2xl border-2 border-[#E5E5E5] bg-white">
        <table className="w-full border-collapse text-xs sm:text-sm">
          {table.hasHeaderRow && table.headers && table.headers.length > 0 && (
            <thead>
              <tr className="bg-[#DDF4FF] border-b-2 border-[#BCE3FA]">
                {Array.from({ length: colCount }, (_, c) => (
                  <th
                    key={c}
                    className="px-3 py-2.5 text-right font-black text-[#0E6BA8] border-l last:border-l-0 border-[#BCE3FA]"
                  >
                    <MathText text={table.headers?.[c] || `عمود ${c + 1}`} />
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-b-0 border-[#E5E5E5] odd:bg-white even:bg-[#FAFAFA]">
                {Array.from({ length: colCount }, (_, c) => {
                  const cell: TableCellConfig = row[c] ?? emptyTableCell('');
                  const k = cellKey(r, c);
                  const val = answers[k] ?? '';
                  const inputType: TableCellInputType = cell.inputType === 'number' ? 'number' : 'text';

                  if (!cell.isBlank) {
                    return (
                      <td
                        key={c}
                        className="px-3 py-2.5 font-bold text-[#3C3C3C] border-l last:border-l-0 border-[#E5E5E5] align-middle"
                      >
                        {cell.value ? (
                          <MathText text={cell.value} />
                        ) : (
                          <span className="text-[#AFAFAF]">—</span>
                        )}
                      </td>
                    );
                  }

                  if (mode === 'exam') {
                    return (
                      <td
                        key={c}
                        className="px-2 py-2 border-l last:border-l-0 border-[#E5E5E5] bg-[#F5ECFF]/40 align-middle min-w-[110px]"
                      >
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-1 text-[10px] font-black">
                            {cell.cue ? (
                              <span className="px-1.5 py-0.5 rounded-md bg-[#A560E8] text-white">
                                <MathText text={cell.cue} />
                              </span>
                            ) : (
                              <span className="text-[#8938D6]">أكمل الفراغ</span>
                            )}
                            <span className="text-[#777777]">
                              {inputType === 'number' ? 'رقم' : 'نص'}
                            </span>
                          </div>
                          <input
                            type="text"
                            inputMode={inputType === 'number' ? 'decimal' : 'text'}
                            dir={inputType === 'number' ? 'ltr' : 'auto'}
                            value={val}
                            onChange={(e) => onChangeAnswer?.(k, e.target.value)}
                            placeholder={inputType === 'number' ? 'اكتب الرقم...' : 'اكتب الإجابة...'}
                            className="w-full rounded-xl border-2 border-[#CE82FF] focus:border-[#8938D6] bg-white px-2.5 py-1.5 text-xs sm:text-sm font-black text-[#3C3C3C] outline-none text-center"
                          />
                        </div>
                      </td>
                    );
                  }

                  if (mode === 'review') {
                    const ok = isTableCellAnswerCorrect(cell, val);
                    return (
                      <td
                        key={c}
                        className={`px-2.5 py-2 border-l last:border-l-0 border-[#E5E5E5] align-middle min-w-[120px] ${
                          ok ? 'bg-[#D7FFB8]/60' : 'bg-[#FFDFE0]/65'
                        }`}
                      >
                        <div className="flex flex-col gap-1 text-xs">
                          <div className="flex items-center justify-between gap-1">
                            {cell.cue && (
                              <span className="px-1.5 py-0.5 rounded bg-white/80 text-[10px] font-black text-[#3C3C3C] border border-[#E5E5E5]">
                                <MathText text={cell.cue} />
                              </span>
                            )}
                            {ok ? (
                              <CheckCircle2 className="w-4 h-4 text-[#46A302] shrink-0" />
                            ) : (
                              <XCircle className="w-4 h-4 text-[#EA2B2B] shrink-0" />
                            )}
                          </div>
                          <div className={`font-black ${ok ? 'text-[#46A302]' : 'text-[#EA2B2B]'}`}>
                            {val.trim() ? val : 'بلا إجابة'}
                          </div>
                          {!ok && cell.expectedAnswer && (
                            <div className="text-[11px] font-black text-[#46A302] bg-white/85 rounded-lg px-2 py-0.5 border border-[#58CC02]/50">
                              الصحيحة: <MathText text={cell.expectedAnswer.replace(/\|/g, ' أو ')} />
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  }

                  // Preview mode (for Editor / View / Starred)
                  return (
                    <td
                      key={c}
                      className="px-2.5 py-2 border-l last:border-l-0 border-[#E5E5E5] bg-[#FFF4CC]/60 align-middle"
                    >
                      <div className="flex flex-col gap-0.5 text-[11px]">
                        <div className="flex items-center gap-1 font-black text-[#9A6B00]">
                          <HelpCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>{cell.cue ? `فراغ (${cell.cue})` : 'فراغ للطالب'}</span>
                          <span className="text-[10px] text-[#777777]">
                            ({inputType === 'number' ? 'رقم' : 'نص'})
                          </span>
                        </div>
                        {cell.expectedAnswer && (
                          <div className="font-black text-[#46A302]">
                            الإجابة: <MathText text={cell.expectedAnswer.replace(/\|/g, ' أو ')} />
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.caption && (
        <p className="text-[11px] font-bold text-[#777777]">
          <MathText text={table.caption} />
        </p>
      )}
    </div>
  );
};

/* ---------------- محرر الجدول التفاعلي داخل QuizEditor ---------------- */

interface EditorProps {
  table: QuizTableQuestion | undefined;
  onChange: (next: QuizTableQuestion) => void;
}

export const QuizTableEditor: React.FC<EditorProps> = ({ table, onChange }) => {
  const current = table ?? createDefaultTableQuestion(3, 3);
  const colCount = Math.max(
    current.headers?.length ?? 0,
    ...(current.rows || []).map((r) => r.length),
    2
  );
  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number }>({ r: 0, c: 0 });

  const update = (patch: Partial<QuizTableQuestion>) =>
    onChange({ ...current, ...patch });

  const updateHeader = (c: number, val: string) => {
    const nextHeaders = Array.from({ length: colCount }, (_, idx) => current.headers?.[idx] ?? '');
    nextHeaders[c] = val;
    update({ headers: nextHeaders, hasHeaderRow: true });
  };

  const updateCell = (r: number, c: number, patch: Partial<TableCellConfig>) => {
    const nextRows = current.rows.map((row, ri) =>
      ri !== r
        ? row
        : Array.from({ length: colCount }, (_, ci) => {
            const cell = row[ci] ?? emptyTableCell('');
            return ci === c ? { ...cell, ...patch } : cell;
          })
    );
    update({ rows: nextRows });
  };

  const addRow = () => {
    if (current.rows.length >= TABLE_LIMITS.maxRows) return;
    const newRow = Array.from({ length: colCount }, () => emptyTableCell(''));
    update({ rows: [...current.rows, newRow] });
  };

  const removeRow = (r: number) => {
    if (current.rows.length <= 1) return;
    const nextRows = current.rows.filter((_, idx) => idx !== r);
    update({ rows: nextRows });
    setSelectedCell((prev) => ({
      r: Math.min(prev.r, nextRows.length - 1),
      c: prev.c,
    }));
  };

  const addCol = () => {
    if (colCount >= TABLE_LIMITS.maxCols) return;
    const nextHeaders = [...Array.from({ length: colCount }, (_, c) => current.headers?.[c] ?? ''), `العمود ${colCount + 1}`];
    const nextRows = current.rows.map((row) => [...row, emptyTableCell('')]);
    update({ headers: nextHeaders, rows: nextRows });
  };

  const removeCol = (c: number) => {
    if (colCount <= 2) return;
    const nextHeaders = Array.from({ length: colCount }, (_, idx) => current.headers?.[idx] ?? '').filter(
      (_, idx) => idx !== c
    );
    const nextRows = current.rows.map((row) =>
      Array.from({ length: colCount }, (_, idx) => row[idx] ?? emptyTableCell('')).filter((_, idx) => idx !== c)
    );
    update({ headers: nextHeaders, rows: nextRows });
    setSelectedCell((prev) => ({
      r: prev.r,
      c: Math.min(prev.c, colCount - 2),
    }));
  };

  const selR = Math.min(selectedCell.r, current.rows.length - 1);
  const selC = Math.min(selectedCell.c, colCount - 1);
  const activeCell: TableCellConfig = current.rows[selR]?.[selC] ?? emptyTableCell('');

  return (
    <div className="rounded-2xl border-2 border-[#1CB0F6]/50 bg-[#F0F9FF]/50 p-3.5 flex flex-col gap-3" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-black text-[#0E6BA8]">
          <Table2 className="w-4 h-4" />
          <span>تصميم الجدول وتحديد الخانات الفارغة</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] font-black text-[#3C3C3C] cursor-pointer bg-white px-2.5 py-1 rounded-xl border border-[#E5E5E5]">
            <input
              type="checkbox"
              checked={current.hasHeaderRow !== false}
              onChange={(e) =>
                update({
                  hasHeaderRow: e.target.checked,
                  headers:
                    current.headers ?? Array.from({ length: colCount }, (_, c) => `العمود ${c + 1}`),
                })
              }
            />
            <span>صف عناوين</span>
          </label>
          <button
            type="button"
            onClick={addRow}
            disabled={current.rows.length >= TABLE_LIMITS.maxRows}
            className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border border-[#1CB0F6] text-[11px] font-black text-[#1899D6] cursor-pointer disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" /> صف
          </button>
          <button
            type="button"
            onClick={addCol}
            disabled={colCount >= TABLE_LIMITS.maxCols}
            className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-white border border-[#1CB0F6] text-[11px] font-black text-[#1899D6] cursor-pointer disabled:opacity-40"
          >
            <Plus className="w-3.5 h-3.5" /> عمود
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={current.title ?? ''}
          onChange={(e) => update({ title: e.target.value })}
          maxLength={TABLE_LIMITS.title}
          placeholder="عنوان الجدول (اختياري)"
          className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] bg-white px-3 py-1.5 text-xs font-bold text-[#3C3C3C] outline-none"
        />
        <input
          type="text"
          value={current.caption ?? ''}
          onChange={(e) => update({ caption: e.target.value })}
          maxLength={TABLE_LIMITS.caption}
          placeholder="ملاحظة أسفل الجدول (اختياري)"
          className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] bg-white px-3 py-1.5 text-xs font-bold text-[#3C3C3C] outline-none"
        />
      </div>

      {/* الشبكة التفاعلية */}
      <div className="w-full overflow-x-auto rounded-2xl border-2 border-[#E5E5E5] bg-white">
        <table className="w-full border-collapse text-xs">
          {current.hasHeaderRow !== false && (
            <thead>
              <tr className="bg-[#DDF4FF] border-b border-[#BCE3FA]">
                {Array.from({ length: colCount }, (_, c) => (
                  <th key={c} className="p-1.5 border-l last:border-l-0 border-[#BCE3FA] min-w-[110px]">
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={current.headers?.[c] ?? ''}
                        onChange={(e) => updateHeader(c, e.target.value)}
                        placeholder={`عنوان ${c + 1}`}
                        className="w-full bg-white rounded-lg border border-[#BCE3FA] px-2 py-1 text-xs font-black text-[#0E6BA8] outline-none"
                      />
                      {colCount > 2 && (
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
          )}
          <tbody>
            {current.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-b-0 border-[#E5E5E5]">
                {Array.from({ length: colCount }, (_, c) => {
                  const cell = row[c] ?? emptyTableCell('');
                  const isSel = selR === r && selC === c;
                  return (
                    <td
                      key={c}
                      onClick={() => setSelectedCell({ r, c })}
                      className={`p-1.5 border-l border-[#E5E5E5] cursor-pointer transition-colors min-w-[110px] ${
                        cell.isBlank
                          ? isSel
                            ? 'bg-[#FFF4CC] ring-2 ring-inset ring-[#FF9600]'
                            : 'bg-[#FFF4CC]/55'
                          : isSel
                          ? 'bg-[#E6F7FF] ring-2 ring-inset ring-[#1CB0F6]'
                          : 'bg-white'
                      }`}
                    >
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-1">
                          <span
                            className={`text-[10px] font-black px-1.5 py-0.5 rounded ${
                              cell.isBlank
                                ? 'bg-[#FFC800] text-[#3C3C3C]'
                                : 'bg-[#F0F0F0] text-[#777777]'
                            }`}
                          >
                            {cell.isBlank
                              ? `فراغ (${cell.inputType === 'number' ? 'رقم' : 'نص'})`
                              : 'ثابت'}
                          </span>
                          {cell.isBlank && cell.cue && (
                            <span className="text-[10px] font-black text-[#8938D6]">{cell.cue}</span>
                          )}
                        </div>
                        <div className="text-xs font-bold text-[#3C3C3C] truncate">
                          {cell.isBlank
                            ? cell.expectedAnswer
                              ? `✓ ${cell.expectedAnswer}`
                              : 'اضغط لتحديد الإجابة'
                            : cell.value || 'خلية فارغة'}
                        </div>
                      </div>
                    </td>
                  );
                })}
                <td className="p-1 text-center">
                  {current.rows.length > 1 && (
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

      {/* لوحة تحرير الخلية المحددة */}
      <div className="rounded-2xl border-2 border-[#E5E5E5] bg-white p-3 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-black text-[#3C3C3C]">
            تعديل الخلية (صف {selR + 1} · عمود {selC + 1})
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                updateCell(selR, selC, {
                  isBlank: false,
                  value: activeCell.value || activeCell.expectedAnswer || '',
                })
              }
              className={`px-3 py-1 rounded-xl border text-xs font-black cursor-pointer ${
                !activeCell.isBlank
                  ? 'bg-[#1CB0F6] border-[#1899D6] text-white'
                  : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
              }`}
            >
              قيمة ثابتة
            </button>
            <button
              type="button"
              onClick={() =>
                updateCell(selR, selC, {
                  isBlank: true,
                  inputType: activeCell.inputType || 'number',
                  expectedAnswer: activeCell.expectedAnswer || activeCell.value || '',
                })
              }
              className={`px-3 py-1 rounded-xl border text-xs font-black cursor-pointer ${
                activeCell.isBlank
                  ? 'bg-[#FFC800] border-[#E0A800] text-[#3C3C3C]'
                  : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
              }`}
            >
              فراغ للطالب
            </button>
          </div>
        </div>

        {!activeCell.isBlank ? (
          <input
            type="text"
            value={activeCell.value}
            maxLength={TABLE_LIMITS.cellText}
            onChange={(e) => updateCell(selR, selC, { value: e.target.value })}
            placeholder="اكتب النص أو الرقم الذي سيظهر ثابتاً في هذه الخلية..."
            className="w-full rounded-xl border-2 border-[#E5E5E5] focus:border-[#1CB0F6] px-3 py-2 text-xs sm:text-sm font-bold text-[#3C3C3C] outline-none"
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-black text-[#777777]">نوع الإجابة</span>
              <select
                value={activeCell.inputType || 'text'}
                onChange={(e) =>
                  updateCell(selR, selC, { inputType: e.target.value as TableCellInputType })
                }
                className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#A560E8] px-2.5 py-2 text-xs font-black text-[#3C3C3C] bg-white outline-none"
              >
                <option value="number">رقم (يدعم الأرقام العربية والإنجليزية)</option>
                <option value="text">نص (كلمة أو عبارة)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-black text-[#777777]">حرف/رمز ظاهر (اختياري)</span>
              <input
                type="text"
                value={activeCell.cue ?? ''}
                maxLength={TABLE_LIMITS.cue}
                onChange={(e) => updateCell(selR, selC, { cue: e.target.value })}
                placeholder="مثال: س أو أ أو القيمة"
                className="rounded-xl border-2 border-[#E5E5E5] focus:border-[#A560E8] px-2.5 py-2 text-xs font-bold text-[#3C3C3C] outline-none"
              />
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-black text-[#46A302]">الإجابة الصحيحة المتوقعة *</span>
              <input
                type="text"
                value={activeCell.expectedAnswer ?? ''}
                maxLength={TABLE_LIMITS.expected}
                onChange={(e) => updateCell(selR, selC, { expectedAnswer: e.target.value })}
                placeholder="مثال: 25 أو 25|٢٥"
                className="rounded-xl border-2 border-[#58CC02] focus:border-[#46A302] px-2.5 py-2 text-xs font-black text-[#3C3C3C] outline-none"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
