export interface Stroke {
  color: string;
  width: number;
  isEraser: boolean;
  pts: number[];
}

export interface UserProfile {
  uid: string;
  fullNameQuad: string;
  email: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type RoomStatus = 'waiting' | 'active' | 'finished';
export type SessionType = 'quiz' | 'interactive';
export type RoomMode = 'quiz' | 'explain' | 'competition';

export interface Room {
  id: string;
  title: string;
  supervisorId: string;
  supervisorName: string;
  status: RoomStatus;
  sessionType?: SessionType;
  mode?: RoomMode;
  explainPresenterId?: string;
  explainPresenterName?: string;
  explainBlockedIds?: string[];
  interactiveEditor?: string;
  interactiveEditorName?: string;
  currentSlideIndex?: number;
  slideCount?: number;
  currentQuestionId: string;
  questionCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InteractiveSlide {
  id: string;
  roomId: string;
  pageIndex: number;
  imageData: string;
  createdAt?: unknown;
}

export interface SlideLayer {
  id: string;
  roomId: string;
  slideId: string;
  authorId: string;
  authorName: string;
  strokes: Stroke[];
  updatedAt?: unknown;
}

export interface SharedExplainBoard {
  roomId: string;
  strokes: Stroke[];
  updatedBy: string;
  updatedByName: string;
  updatedAt?: unknown;
}

export interface ExplainLayer {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  strokes: Stroke[];
  updatedAt?: unknown;
}

export interface Participant {
  uid: string;
  roomId: string;
  fullNameQuad: string;
  score: number;
  correctCount: number;
  joinedAt?: unknown;
  updatedAt?: unknown;
}

export type QuestionStatus = 'solving' | 'correct' | 'unanswered';

export interface Question {
  id: string;
  roomId: string;
  orderIndex: number;
  text: string;
  imageData: string;
  choices?: string[];
  chart?: QuizChart;
  sourceQuizTitle?: string;
  status: QuestionStatus;
  attemptsUsed: number;
  wrongStudentIds: string[];
  winnerId: string;
  winnerName: string;
  timerSeconds?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type BoardVerdict = 'pending' | 'correct' | 'wrong';

export interface StudentBoard {
  studentId: string;
  studentName: string;
  roomId: string;
  questionId: string;
  strokes: Stroke[];
  submitted: boolean;
  verdict: BoardVerdict;
  updatedAt?: unknown;
}

export interface ParticipantSummary {
  uid: string;
  fullNameQuad: string;
  score: number;
  correctCount: number;
  wrongCount?: number;
  totalTimeMs?: number;
}

export interface SavedBoardSnapshot {
  studentId: string;
  studentName: string;
  strokes: Stroke[];
  submitted: boolean;
  verdict: BoardVerdict;
  chosenIndex?: number;
  chosenText?: string;
  timeMs?: number;
}

export interface SavedQuestion {
  id: string;
  ownerId: string;
  orderIndex: number;
  text: string;
  imageData: string;
  choices?: string[];
  correctIndex?: number;
  explanation?: string;
  chart?: QuizChart;
  winnerTimeMs?: number;
  status: QuestionStatus;
  winnerName: string;
  boards: SavedBoardSnapshot[];
  createdAt?: unknown;
}

export interface SavedTest {
  id: string;
  ownerId: string;
  roomCode: string;
  title: string;
  userRole: 'supervisor' | 'student';
  supervisorName: string;
  totalQuestions: number;
  participantsSummary: ParticipantSummary[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type ChartType = 'bar' | 'hbar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  values: number[];
}

/** رسم بياني يُرسم من القيم داخل السؤال */
export interface QuizChart {
  type: ChartType;
  title: string;
  xLabel: string;
  yLabel: string;
  labels: string[];
  series: ChartSeries[];
}

/** سؤال داخل "اختباراتي" — النصوص قد تحتوي رياضيات بصيغة $...$ */
export interface QuizQuestion {
  id: string;
  text: string;
  choices: string[];
  /** فهرس الإجابة الصحيحة (يبدأ من 0)، أو -1 إن لم تُحدد */
  correctIndex: number;
  answer: string;
  explanation: string;
  chart?: QuizChart;
}

export interface MyQuiz {
  id: string;
  ownerId: string;
  title: string;
  questions: QuizQuestion[];
  questionCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/* ===================== وضع الاختبار ===================== */

export type ExamTiming = 'none' | 'perQuestion' | 'total';

export interface ExamSettings {
  sourceMode: 'single' | 'mix';
  /** في المزج: سؤال واحد من كل نموذج، أو عدد محدد موزّع على النماذج */
  mixMode: 'onePerQuiz' | 'total';
  quizIds: string[];
  quizTitles: string[];
  questionCount: number;
  shuffleQuestions: boolean;
  shuffleChoices: boolean;
  timing: ExamTiming;
  /** ثوانٍ لكل سؤال، أو ثوانٍ للاختبار كاملاً حسب timing */
  seconds: number;
}

export interface ExamQuestion {
  id: string;
  sourceQuizId: string;
  sourceTitle: string;
  text: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  chart?: QuizChart;
}

export interface QuizAttempt {
  id: string;
  ownerId: string;
  title: string;
  settings: ExamSettings;
  questions: ExamQuestion[];
  /** الخيار المختار لكل سؤال (-1 = بلا إجابة) */
  answers: number[];
  score: number;
  total: number;
  durationSec: number;
  /** وقت الانتهاء بالملي ثانية (يبقى ثابتاً عند النقل بين القواعد) */
  finishedAt: number;
  createdAt?: unknown;
}

/* ===================== المشاركة داخل الغرفة والمنافسة ===================== */

export interface SharedQuiz {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  authorRole: 'supervisor' | 'student';
  title: string;
  questions: QuizQuestion[];
  questionCount: number;
  updatedAt?: unknown;
}

export type CompetitionStatus = 'active' | 'finished';
export type CompetitionPhase = 'countdown' | 'question';

export interface CompetitionCompetitor {
  uid: string;
  name: string;
  role: 'supervisor' | 'student';
}

export interface CompetitionAttempt {
  uid: string;
  name: string;
  choiceIndex: number;
  isCorrect: boolean;
  timeMs: number;
}

export interface Competition {
  id: string;
  roomId: string;
  createdBy: string;
  createdByName: string;
  title: string;
  settings: ExamSettings;
  includeSupervisor: boolean;
  competitorIds: string[];
  competitors: CompetitionCompetitor[];
  status: CompetitionStatus;
  phase: CompetitionPhase;
  currentIndex: number;
  totalQuestions: number;
  countdownSec: number;
  phaseStartedAt?: unknown;
  totalElapsedMs: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface CompetitionQuestion {
  id: string;
  roomId: string;
  competitionId: string;
  orderIndex: number;
  question: ExamQuestion;
  status: QuestionStatus;
  winnerId: string;
  winnerName: string;
  winnerChoiceIndex: number;
  winnerTimeMs: number;
  wrongPlayerIds: string[];
  attempts: CompetitionAttempt[];
  updatedAt?: unknown;
}

