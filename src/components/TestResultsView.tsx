import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { ArrowRight, CheckCircle2, X, ZoomIn } from 'lucide-react';
import { db, getTimestampMillis, handleFirestoreError, OperationType } from '../firebase';
import {
  loadSessionSnapshot,
  saveSavedTestsListSnapshot,
  type StoredSavedTestsSnapshot,
} from '../localDraftStore';
import { MathText } from '../mathText';
import type {
  Competition,
  CompetitionAttempt,
  CompetitionQuestion,
  InteractiveSlide,
  Participant,
  ParticipantSummary,
  Question,
  Room,
  SavedBoardSnapshot,
  SavedQuestion,
  SavedTest,
  SlideLayer,
  StudentBoard,
  UserProfile,
} from '../types';
import { ChartView } from './ChartView';
import { FigureView } from './FigureView';
import { formatTimeSeconds } from './CompetitionArena';
import {
  DUO_IMAGES,
  DuoArtwork,
  DuoCheckBadge,
  DuoCrossBadge,
  DuoCrownIcon,
  DuoGemIcon,
} from './DuoIcons';
import { WhiteboardPreview, ZoomablePreviewStage } from './WhiteboardCanvas';

interface TestResultsViewProps {
  profile: UserProfile;
  // Either live finished room OR archived savedTest
  liveRoom?: Room;
  liveParticipants?: Participant[];
  isSupervisor?: boolean;
  archivedTest?: SavedTest;
  archivedQuestions?: SavedQuestion[];
  onBack: () => void;
}

export const TestResultsView: React.FC<TestResultsViewProps> = ({
  profile,
  liveRoom,
  liveParticipants = [],
  isSupervisor = false,
  archivedTest,
  archivedQuestions,
  onBack,
}) => {
  const [loading, setLoading] = useState<boolean>(Boolean(liveRoom));
  const [questionsData, setQuestionsData] = useState<SavedQuestion[]>(archivedQuestions ?? []);
  const [participantsData, setParticipantsData] = useState<ParticipantSummary[]>(
    archivedTest?.participantsSummary ?? []
  );
  const [savedNotice, setSavedNotice] = useState<boolean>(false);
  const [zoomedBoard, setZoomedBoard] = useState<{
    board: SavedBoardSnapshot;
    backgroundImage?: string;
  } | null>(null);
  const [zoomedImg, setZoomedImg] = useState<string | null>(null);

  const title = liveRoom ? liveRoom.title : archivedTest?.title ?? 'نتائج الاختبار';
  const roomCode = liveRoom ? liveRoom.id : archivedTest?.roomCode ?? '';
  const supervisorName = liveRoom
    ? liveRoom.supervisorName
    : archivedTest?.supervisorName ?? '';

  useEffect(() => {
    if (!liveRoom) return;

    let cancelled = false;
    async function loadAndPersistLiveResults() {
      if (!liveRoom) return;
      setLoading(true);
      try {
        const assembledQuestions: SavedQuestion[] = [];
        let compParticipantSummary: ParticipantSummary[] | null = null;

        if (liveRoom.sessionType === 'interactive' && liveRoom.mode === 'competition') {
          const cSnap = await getDocs(
            query(
              collection(db, 'rooms', liveRoom.id, 'competitions'),
              where('roomId', '==', liveRoom.id)
            )
          );
          const comps: Competition[] = [];
          cSnap.forEach((d) => comps.push(d.data() as Competition));
          comps.sort(
            (a, b) => getTimestampMillis(b.createdAt) - getTimestampMillis(a.createdAt)
          );
          const latestComp = comps[0];

          if (latestComp) {
            const cqSnap = await getDocs(
              query(
                collection(
                  db,
                  'rooms',
                  liveRoom.id,
                  'competitions',
                  latestComp.id,
                  'questions'
                ),
                where('roomId', '==', liveRoom.id),
                where('competitionId', '==', latestComp.id)
              )
            );
            const rawCQs: CompetitionQuestion[] = [];
            cqSnap.forEach((d) => rawCQs.push(d.data() as CompetitionQuestion));
            rawCQs.sort((a, b) => a.orderIndex - b.orderIndex);

            for (const cq of rawCQs) {
              const bSnap = await getDocs(
                query(
                  collection(
                    db,
                    'rooms',
                    liveRoom.id,
                    'competitions',
                    latestComp.id,
                    'questions',
                    cq.id,
                    'boards'
                  ),
                  where('roomId', '==', liveRoom.id),
                  where('questionId', '==', cq.id)
                )
              );
              const boardMap = new Map<string, StudentBoard>();
              bSnap.forEach((d) => {
                const b = d.data() as StudentBoard;
                boardMap.set(b.studentId, b);
              });

              const attemptsByUid = new Map<string, CompetitionAttempt>();
              for (const att of cq.attempts || []) {
                attemptsByUid.set(att.uid, att);
              }

              const boardsList: SavedBoardSnapshot[] = latestComp.competitors.map((c) => {
                const sb = boardMap.get(c.uid);
                const att = attemptsByUid.get(c.uid);
                const choiceIdx = att?.choiceIndex ?? -1;
                const choiceTxt =
                  choiceIdx >= 0 && choiceIdx < cq.question.choices.length
                    ? cq.question.choices[choiceIdx]
                    : '';
                return {
                  studentId: c.uid,
                  studentName: c.name,
                  strokes: sb?.strokes ?? [],
                  submitted: Boolean(att) || (sb?.strokes?.length ?? 0) > 0,
                  verdict: att ? (att.isCorrect ? 'correct' : 'wrong') : 'pending',
                  chosenIndex: choiceIdx,
                  chosenText: choiceTxt,
                  timeMs: att?.timeMs ?? 0,
                };
              });

              assembledQuestions.push({
                id: cq.id,
                ownerId: profile.uid,
                orderIndex: cq.orderIndex,
                text: cq.question.text.slice(0, 2000),
                imageData: '',
                choices: cq.question.choices,
                correctIndex: cq.question.correctIndex,
                explanation: (cq.question.explanation || '').slice(0, 2000),
                ...(cq.question.chart ? { chart: cq.question.chart } : {}),
                ...(cq.question.figure ? { figure: cq.question.figure } : {}),
                ...(cq.question.explanationChart ? { explanationChart: cq.question.explanationChart } : {}),
                ...(cq.question.explanationFigure ? { explanationFigure: cq.question.explanationFigure } : {}),
                winnerTimeMs: cq.winnerTimeMs || 0,
                status: cq.status === 'solving' ? 'unanswered' : cq.status,
                winnerName: (cq.winnerName || '').slice(0, 120),
                boards: boardsList,
                createdAt: cq.updatedAt,
              });
            }

            compParticipantSummary = latestComp.competitors
              .map((c) => {
                let correctCount = 0;
                let wrongCount = 0;
                let totalTimeMs = 0;
                for (const cq of rawCQs) {
                  if (cq.status === 'correct' && cq.winnerId === c.uid) correctCount++;
                  for (const att of cq.attempts || []) {
                    if (att.uid === c.uid) {
                      if (!att.isCorrect) wrongCount++;
                      totalTimeMs += att.timeMs || 0;
                    }
                  }
                }
                return {
                  uid: c.uid,
                  fullNameQuad: c.name,
                  score: correctCount,
                  correctCount,
                  wrongCount,
                  totalTimeMs,
                };
              })
              .sort(
                (a, b) =>
                  b.score - a.score || (a.totalTimeMs ?? 0) - (b.totalTimeMs ?? 0)
              );
          }
        } else if (liveRoom.sessionType === 'interactive') {
          const sSnap = await getDocs(
            query(collection(db, 'rooms', liveRoom.id, 'slides'), where('roomId', '==', liveRoom.id))
          );
          const rawSlides: InteractiveSlide[] = [];
          sSnap.forEach((d) => rawSlides.push(d.data() as InteractiveSlide));
          rawSlides.sort((a, b) => a.pageIndex - b.pageIndex);

          for (const slide of rawSlides) {
            const lSnap = await getDocs(
              query(
                collection(db, 'rooms', liveRoom.id, 'slides', slide.id, 'layers'),
                where('roomId', '==', liveRoom.id),
                where('slideId', '==', slide.id)
              )
            );
            const boardsList: SavedBoardSnapshot[] = [];
            lSnap.forEach((d) => {
              const layer = d.data() as SlideLayer;
              if ((layer.strokes?.length ?? 0) > 0) {
                boardsList.push({
                  studentId: layer.authorId,
                  studentName: layer.authorName,
                  strokes: layer.strokes ?? [],
                  submitted: true,
                  verdict: 'pending',
                });
              }
            });

            assembledQuestions.push({
              id: slide.id,
              ownerId: profile.uid,
              orderIndex: slide.pageIndex,
              text: (slide.fileName
                ? `${slide.fileName} — صفحة ${slide.filePageIndex ?? slide.pageIndex}`
                : `صفحة ${slide.pageIndex}`
              ).slice(0, 2000),
              imageData: slide.imageData,
              status: 'solving',
              winnerName: '',
              boards: boardsList,
              createdAt: slide.createdAt,
            });
          }
        } else {
          const qSnap = await getDocs(
            query(collection(db, 'rooms', liveRoom.id, 'questions'), where('roomId', '==', liveRoom.id))
          );
          const rawQuestions: Question[] = [];
          qSnap.forEach((d) => rawQuestions.push(d.data() as Question));
          rawQuestions.sort((a, b) => a.orderIndex - b.orderIndex);

          for (const q of rawQuestions) {
            const bSnap = await getDocs(
              query(
                collection(db, 'rooms', liveRoom.id, 'questions', q.id, 'boards'),
                where('roomId', '==', liveRoom.id),
                where('questionId', '==', q.id)
              )
            );
            const boardMap = new Map<string, StudentBoard>();
            bSnap.forEach((d) => {
              const b = d.data() as StudentBoard;
              boardMap.set(b.studentId, b);
            });

            const boardsList: SavedBoardSnapshot[] = liveParticipants.map((p) => {
              const found = boardMap.get(p.uid);
              return {
                studentId: p.uid,
                studentName: p.fullNameQuad,
                strokes: found?.strokes ?? [],
                submitted: found?.submitted ?? false,
                verdict: found?.verdict ?? 'pending',
              };
            });

            // Include any extra board not in participants list just in case
            boardMap.forEach((b, sid) => {
              if (!liveParticipants.some((p) => p.uid === sid)) {
                boardsList.push({
                  studentId: b.studentId,
                  studentName: b.studentName,
                  strokes: b.strokes ?? [],
                  submitted: b.submitted ?? false,
                  verdict: b.verdict ?? 'pending',
                });
              }
            });

            assembledQuestions.push({
              id: q.id,
              ownerId: profile.uid,
              orderIndex: q.orderIndex,
              text: q.text,
              imageData: q.imageData,
              ...(q.choices ? { choices: q.choices } : {}),
              ...(q.chart ? { chart: q.chart } : {}),
              ...(q.figure ? { figure: q.figure } : {}),
              status: q.status,
              winnerName: q.winnerName,
              boards: boardsList,
              createdAt: q.createdAt,
            });
          }
        }

        const pSummary: ParticipantSummary[] =
          compParticipantSummary ??
          [...liveParticipants]
            .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount)
            .map((p) => ({
              uid: p.uid,
              fullNameQuad: p.fullNameQuad,
              score: p.score,
              correctCount: p.correctCount,
            }));

        if (cancelled) return;
        setQuestionsData(assembledQuestions);
        setParticipantsData(pSummary);

        // Mirror to IndexedDB snapshot so saved test survives quota failover
        const localSavedObj: SavedTest = {
          id: liveRoom.id,
          ownerId: profile.uid,
          roomCode: liveRoom.id,
          title: liveRoom.title,
          userRole: isSupervisor ? 'supervisor' : 'student',
          supervisorName: liveRoom.supervisorName,
          totalQuestions: assembledQuestions.length,
          participantsSummary: pSummary,
        };
        const existingSnap = await loadSessionSnapshot<StoredSavedTestsSnapshot>('saved_tests');
        const prevTests =
          existingSnap && existingSnap.ownerId === profile.uid
            ? existingSnap.tests.filter((t) => t.id !== liveRoom.id)
            : [];
        void saveSavedTestsListSnapshot(
          profile.uid,
          [localSavedObj, ...prevTests],
          { [liveRoom.id]: assembledQuestions }
        );

        // Auto-save full session + all boards/slides into the user's own personal savedTests archive
        const savedTestRef = doc(db, 'users', profile.uid, 'savedTests', liveRoom.id);
        const existingSaved = await getDoc(savedTestRef);
        if (!existingSaved.exists()) {
          const CHUNK = 5;
          const firstChunk = assembledQuestions.slice(0, CHUNK);
          const firstBatch = writeBatch(db);
          firstBatch.set(savedTestRef, {
            id: liveRoom.id,
            ownerId: profile.uid,
            roomCode: liveRoom.id,
            title: liveRoom.title,
            userRole: isSupervisor ? 'supervisor' : 'student',
            supervisorName: liveRoom.supervisorName,
            totalQuestions: assembledQuestions.length,
            participantsSummary: pSummary,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          for (const sq of firstChunk) {
            const sqRef = doc(
              db,
              'users',
              profile.uid,
              'savedTests',
              liveRoom.id,
              'questions',
              sq.id
            );
            firstBatch.set(sqRef, {
              id: sq.id,
              ownerId: profile.uid,
              orderIndex: sq.orderIndex,
              text: sq.text,
              imageData: sq.imageData,
              ...(sq.choices ? { choices: sq.choices } : {}),
              ...(typeof sq.correctIndex === 'number' ? { correctIndex: sq.correctIndex } : {}),
              ...(sq.explanation ? { explanation: sq.explanation } : {}),
              ...(sq.chart ? { chart: sq.chart } : {}),
              ...(sq.figure ? { figure: sq.figure } : {}),
              ...(sq.explanationChart ? { explanationChart: sq.explanationChart } : {}),
              ...(sq.explanationFigure ? { explanationFigure: sq.explanationFigure } : {}),
              ...(typeof sq.winnerTimeMs === 'number' ? { winnerTimeMs: sq.winnerTimeMs } : {}),
              status: sq.status,
              winnerName: sq.winnerName,
              boards: sq.boards,
              createdAt: serverTimestamp(),
            });
          }
          await firstBatch.commit();

          for (let i = CHUNK; i < assembledQuestions.length; i += CHUNK) {
            const batch = writeBatch(db);
            for (const sq of assembledQuestions.slice(i, i + CHUNK)) {
              const sqRef = doc(
                db,
                'users',
                profile.uid,
                'savedTests',
                liveRoom.id,
                'questions',
                sq.id
              );
              batch.set(sqRef, {
                id: sq.id,
                ownerId: profile.uid,
                orderIndex: sq.orderIndex,
                text: sq.text,
                imageData: sq.imageData,
                ...(sq.choices ? { choices: sq.choices } : {}),
                ...(typeof sq.correctIndex === 'number' ? { correctIndex: sq.correctIndex } : {}),
                ...(sq.explanation ? { explanation: sq.explanation } : {}),
                ...(sq.chart ? { chart: sq.chart } : {}),
                ...(sq.figure ? { figure: sq.figure } : {}),
                ...(sq.explanationChart ? { explanationChart: sq.explanationChart } : {}),
                ...(sq.explanationFigure ? { explanationFigure: sq.explanationFigure } : {}),
                ...(typeof sq.winnerTimeMs === 'number' ? { winnerTimeMs: sq.winnerTimeMs } : {}),
                status: sq.status,
                winnerName: sq.winnerName,
                boards: sq.boards,
                createdAt: serverTimestamp(),
              });
            }
            await batch.commit();
          }
        }
        if (!cancelled) {
          setSavedNotice(true);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${profile.uid}/savedTests`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadAndPersistLiveResults();
    return () => {
      cancelled = true;
    };
  }, [liveRoom?.id, profile.uid, isSupervisor]);

  const sortedParticipants = [...participantsData].sort(
    (a, b) =>
      b.score - a.score ||
      b.correctCount - a.correctCount ||
      (a.totalTimeMs ?? 0) - (b.totalTimeMs ?? 0)
  );

  const isInteractiveArchive =
    (liveRoom?.sessionType === 'interactive' && liveRoom?.mode !== 'competition') ||
    (questionsData.length > 0 && questionsData.every((q) => q.status === 'solving'));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      {/* Top Celebration Banner */}
      <div className="duo-card p-6 sm:p-8 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex flex-col sm:flex-row items-center gap-5 text-center sm:text-right">
          <DuoArtwork
            src={DUO_IMAGES.trophy}
            alt="كأس نهاية الاختبار"
            className="w-28 h-28 shrink-0"
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-extrabold text-[#E5A400]">
              النتائج النهائية وسجل الصبورات
            </span>
            <h1 className="text-2xl sm:text-3xl font-black text-[#3C3C3C]">{title}</h1>
            <p className="text-sm font-bold text-[#777777]">
              المشرف: <span className="text-[#3C3C3C]">{supervisorName}</span>
              {' · '}
              رمز الغرفة:{' '}
              <span className="font-latin font-black text-[#1CB0F6]">{roomCode}</span>
              {' · '}
              عدد الأسئلة:{' '}
              <span className="font-latin font-black text-[#3C3C3C]">
                {questionsData.length}
              </span>
            </p>
            {savedNotice && (
              <div className="flex items-center justify-center sm:justify-start gap-1.5 text-xs font-extrabold text-[#46A302] mt-1">
                <CheckCircle2 className="w-4 h-4" />
                <span>تم حفظ الاختبار كاملاً مع جميع الصبورات في حسابك</span>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="duo-btn flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-[5px] text-white text-base font-black cursor-pointer whitespace-nowrap"
        >
          <ArrowRight className="w-5 h-5" />
          <span>العودة للرئيسية</span>
        </button>
      </div>

      {loading ? (
        <div className="duo-card p-12 text-center text-base font-extrabold text-[#777777]">
          جاري تجميع الأسئلة وصبورات الطلاب وحفظها في حسابك...
        </div>
      ) : (
        <>
          {/* Leaderboard */}
          <div className="duo-card p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2.5 pb-3 border-b-2 border-[#F0F0F0]">
              <DuoCrownIcon className="w-6 h-6" />
              <h2 className="text-xl font-black text-[#3C3C3C]">ترتيب الطلاب</h2>
            </div>

            {sortedParticipants.length === 0 ? (
              <p className="text-sm font-bold text-[#777777]">لم يشارك طلاب في هذه الجلسة.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {sortedParticipants.map((p, idx) => (
                  <div
                    key={p.uid}
                    className={`flex items-center justify-between gap-3 p-4 rounded-2xl border-2 ${
                      idx === 0 && p.score > 0
                        ? 'bg-[#FFF4CC]/60 border-[#FFC800]'
                        : 'bg-[#F7F7F7] border-[#E5E5E5]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`font-latin w-9 h-9 rounded-xl flex items-center justify-center font-black text-base shrink-0 ${
                          idx === 0 && p.score > 0
                            ? 'bg-[#FFC800] text-[#3C3C3C]'
                            : 'bg-white border-2 border-[#E5E5E5] text-[#777777]'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-black text-[#3C3C3C] truncate">
                          {p.fullNameQuad}
                        </p>
                        <p className="text-xs font-bold text-[#777777] flex flex-wrap gap-2">
                          <span>
                            الإجابات الصحيحة:{' '}
                            <span className="font-latin font-black text-[#46A302]">
                              {p.correctCount}
                            </span>
                          </span>
                          {typeof p.wrongCount === 'number' && (
                            <span>
                              خطأ:{' '}
                              <span className="font-latin font-black text-[#EA2B2B]">
                                {p.wrongCount}
                              </span>
                            </span>
                          )}
                          {typeof p.totalTimeMs === 'number' && p.totalTimeMs > 0 && (
                            <span>
                              الوقت:{' '}
                              <span className="font-latin font-black text-[#1899D6]">
                                {formatTimeSeconds(p.totalTimeMs)}
                              </span>
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <DuoGemIcon className="w-4 h-4" />
                      <span className="font-latin text-base font-black text-[#1899D6]">
                        {p.score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* All Questions / Interactive Slides & Whiteboards */}
          <div className="flex flex-col gap-5">
            <h2 className="text-xl font-black text-[#3C3C3C]">
              {isInteractiveArchive
                ? `صفحات الملف التفاعلي والحلول (${questionsData.length})`
                : `الأسئلة وصبورات جميع الطلاب (${questionsData.length})`}
            </h2>

            {questionsData.length === 0 ? (
              <div className="duo-card p-8 text-center text-sm font-bold text-[#777777]">
                {isInteractiveArchive
                  ? 'لم يتم رفع صفحات في هذه الجلسة التفاعلية.'
                  : 'لم يتم إدراج أسئلة في هذا الاختبار.'}
              </div>
            ) : (
              questionsData.map((q) => (
                <div key={q.id} className="duo-card p-5 sm:p-6 flex flex-col gap-5">
                  {/* Question / Slide Header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b-2 border-[#F0F0F0]">
                    <div className="flex items-start gap-2.5 flex-1 min-w-0">
                      <span className="font-latin px-3 py-1 rounded-xl bg-[#1CB0F6] text-white text-sm font-black shrink-0">
                        {q.status === 'solving' ? `ص${q.orderIndex}` : `س${q.orderIndex}`}
                      </span>
                      <MathText
                        text={q.text || 'سؤال بصورة مرفقة'}
                        className="text-lg font-black text-[#3C3C3C] flex-1"
                      />
                    </div>

                    {q.status === 'correct' && q.winnerName ? (
                      <div className="flex items-center gap-2 text-[#46A302] font-black text-sm shrink-0">
                        <DuoCheckBadge className="w-5 h-5" />
                        <span>
                          أجابه: {q.winnerName}
                          {(q.winnerTimeMs ?? 0) > 0
                            ? ` (${formatTimeSeconds(q.winnerTimeMs ?? 0)})`
                            : ''}
                        </span>
                      </div>
                    ) : q.status === 'solving' ? (
                      <div className="flex items-center gap-2 text-[#1899D6] font-black text-sm shrink-0">
                        <span>صفحة تفاعلية محفوظة</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-[#EA2B2B] font-black text-sm shrink-0">
                        <DuoCrossBadge className="w-5 h-5" />
                        <span>لم تُحسب الإجابة لأحد</span>
                      </div>
                    )}
                  </div>

                  {q.chart && <ChartView chart={q.chart} className="max-w-lg" />}
                  {q.figure && <FigureView figure={q.figure} className="max-w-lg" />}

                  {q.imageData && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setZoomedImg(q.imageData)}
                        className="relative rounded-2xl overflow-hidden border-2 border-[#E5E5E5] bg-[#F7F7F7] cursor-pointer"
                      >
                        <img
                          src={q.imageData}
                          alt={`صورة السؤال ${q.orderIndex}`}
                          className="max-h-44 w-auto object-contain"
                        />
                      </button>
                    </div>
                  )}

                  {q.choices && q.choices.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {q.choices.map((ch, idx) => {
                        const isCorrect = typeof q.correctIndex === 'number' && idx === q.correctIndex;
                        return (
                          <div
                            key={idx}
                            className={`flex items-center gap-2 p-2.5 rounded-xl border-2 text-xs sm:text-sm font-bold ${
                              isCorrect
                                ? 'bg-[#D7FFB8]/60 border-[#58CC02] text-[#46A302]'
                                : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#3C3C3C]'
                            }`}
                          >
                            <span
                              className={`font-latin w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black shrink-0 ${
                                isCorrect
                                  ? 'bg-[#58CC02] text-white'
                                  : 'bg-white border border-[#E5E5E5] text-[#777777]'
                              }`}
                            >
                              {idx + 1}
                            </span>
                            <MathText text={ch} className="flex-1" />
                            {isCorrect && <CheckCircle2 className="w-4 h-4 shrink-0" />}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(q.explanation || q.explanationChart || q.explanationFigure) && (
                    <div className="p-3.5 rounded-xl bg-[#FFFDF2] border-2 border-[#FFC800] text-xs sm:text-sm font-bold text-[#3C3C3C] flex flex-col gap-2">
                      <span className="font-black text-[#9A6B00] text-[11px]">شرح الإجابة:</span>
                      {q.explanation && <MathText text={q.explanation} />}
                      {q.explanationChart && <ChartView chart={q.explanationChart} className="max-w-lg" />}
                      {q.explanationFigure && <FigureView figure={q.explanationFigure} className="max-w-lg" />}
                    </div>
                  )}

                  {/* Student Boards / Interactive Annotations for This Item */}
                  {q.boards.length === 0 ? (
                    <p className="text-sm font-bold text-[#777777]">
                      {q.status === 'solving'
                        ? 'لم تُسجّل كتابات فوق هذه الصفحة.'
                        : 'لا توجد صبورات مسجلة لهذا السؤال.'}
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {q.boards.map((b) => (
                        <div
                          key={b.studentId}
                          className={`p-3.5 rounded-2xl border-2 flex flex-col gap-2.5 ${
                            b.verdict === 'correct'
                              ? 'border-[#58CC02] bg-[#D7FFB8]/30'
                              : b.verdict === 'wrong'
                              ? 'border-[#FF4B4B] bg-[#FFDFE0]/30'
                              : 'border-[#E5E5E5] bg-[#F7F7F7]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-black text-[#3C3C3C] truncate">
                                {b.studentName}
                              </p>
                              <p className="text-xs font-bold text-[#777777] flex flex-wrap items-center gap-1.5">
                                <span>
                                  {b.verdict === 'correct'
                                    ? 'إجابة صحيحة'
                                    : b.verdict === 'wrong'
                                    ? 'إجابة خاطئة'
                                    : q.status === 'solving'
                                    ? 'حل تفاعلي على الصفحة'
                                    : b.submitted
                                    ? 'تم التسليم'
                                    : 'لم يُسلّم'}
                                </span>
                                {(b.timeMs ?? 0) > 0 && (
                                  <span className="font-latin text-[#1899D6]">
                                    ({formatTimeSeconds(b.timeMs ?? 0)})
                                  </span>
                                )}
                              </p>
                              {b.chosenText && (
                                <div className="mt-1 text-xs font-extrabold text-[#3C3C3C] bg-white/80 rounded-lg px-2 py-1 border border-[#E5E5E5]">
                                  <span className="text-[#777777] ml-1">اختار:</span>
                                  <MathText text={b.chosenText} className="inline" />
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setZoomedBoard({
                                  board: b,
                                  backgroundImage: q.imageData || undefined,
                                })
                              }
                              className="p-2 rounded-xl bg-white border border-[#E5E5E5] text-[#3C3C3C] hover:text-[#1899D6] cursor-pointer shrink-0"
                              title="تكبير السبورة"
                            >
                              <ZoomIn className="w-4 h-4" />
                            </button>
                          </div>
                          <WhiteboardPreview
                            strokes={b.strokes || []}
                            backgroundImage={q.imageData || undefined}
                            emptyText="سبورة فارغة"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* Zoomed Board Modal */}
      {zoomedBoard && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-2.5 sm:p-4"
          onClick={() => setZoomedBoard(null)}
        >
          <div
            className="bg-white rounded-3xl p-3.5 sm:p-5 max-w-5xl w-full flex flex-col gap-3 sm:gap-4 max-h-[95dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <h3 className="text-base sm:text-lg font-black text-[#3C3C3C] truncate">
                سبورة: {zoomedBoard.board.studentName}
              </h3>
              <button
                type="button"
                onClick={() => setZoomedBoard(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ZoomablePreviewStage
              imageSrc={zoomedBoard.backgroundImage}
              strokes={zoomedBoard.board.strokes || []}
            />
          </div>
        </div>
      )}

      {/* Zoomed Question Image Modal */}
      {zoomedImg && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-2.5 sm:p-4"
          onClick={() => setZoomedImg(null)}
        >
          <div
            className="bg-white rounded-3xl p-3 sm:p-4 max-w-5xl w-full flex flex-col gap-3 max-h-[95dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <span className="font-black text-sm sm:text-base text-[#3C3C3C]">
                معاينة وتكبير الصفحة / الصورة
              </span>
              <button
                type="button"
                onClick={() => setZoomedImg(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <ZoomablePreviewStage imageSrc={zoomedImg} />
          </div>
        </div>
      )}
    </div>
  );
};
