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
  fileId?: string;
  fileName?: string;
  filePageIndex?: number;
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
  figure?: QuizFigure;
  questionType?: QuestionKind;
  table?: QuizTableQuestion;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
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
  figure?: QuizFigure;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
  questionType?: QuestionKind;
  table?: QuizTableQuestion;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
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

export type FigureColor = 'ink' | 'blue' | 'green' | 'gold' | 'purple' | 'red' | 'gray' | 'white';

export type FigureLabelPos =
  | 'auto'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export interface FigurePoint {
  id: string;
  x: number;
  y: number;
  label?: string;
  labelPos?: FigureLabelPos;
  dot?: boolean;
}

export type FigureElement =
  | {
      type: 'polygon';
      points: string[];
      fill?: FigureColor | 'none';
      fillOpacity?: number;
      stroke?: FigureColor;
      dashed?: boolean;
      sideLabels?: string[];
      ticks?: number[];
    }
  | {
      type: 'segment';
      from: string;
      to: string;
      extendFrom?: boolean;
      extendTo?: boolean;
      stroke?: FigureColor;
      dashed?: boolean;
      label?: string;
      ticks?: number;
      parallel?: number;
    }
  | {
      type: 'circle';
      center: string;
      r: number;
      fill?: FigureColor | 'none';
      fillOpacity?: number;
      stroke?: FigureColor;
      dashed?: boolean;
      showCenter?: boolean;
      radiusAngleDeg?: number;
      radiusLabel?: string;
      diameterAngleDeg?: number;
      diameterLabel?: string;
    }
  | {
      type: 'arc';
      center: string;
      r: number;
      startDeg: number;
      endDeg: number;
      sector?: boolean;
      fill?: FigureColor | 'none';
      fillOpacity?: number;
      stroke?: FigureColor;
      dashed?: boolean;
      label?: string;
    }
  | {
      type: 'angle';
      a: string;
      vertex: string;
      b: string;
      label?: string;
      right?: boolean;
      arcs?: number;
      reflex?: boolean;
      color?: FigureColor;
      r?: number;
    }
  | {
      type: 'label';
      x: number;
      y: number;
      text: string;
      color?: FigureColor;
    };

/** شكل هندسي قابل للرسم متجهياً بدقة داخل الأسئلة والشرح */
export interface QuizFigure {
  title?: string;
  caption?: string;
  grid?: boolean;
  points: FigurePoint[];
  elements: FigureElement[];
}

export type QuestionKind = 'mcq' | 'table';
export type TableCellInputType = 'number' | 'text';

export interface TableCellConfig {
  /** النص الثابت الظاهر في الخلية (عند عدم كونها فراغاً، أو كنص توضيحي) */
  value: string;
  /** هل هذه الخلية فراغ يملؤه الطالب؟ */
  isBlank?: boolean;
  /** نوع الإجابة المطلوبة في هذا الفراغ: رقم أم نص */
  inputType?: TableCellInputType;
  /** حرف أو رمز ظاهر داخل الفراغ مثل س أو ص أو أ (اختياري) */
  cue?: string;
  /** الإجابة الصحيحة المتوقعة لهذا الفراغ */
  expectedAnswer?: string;
}

export interface QuizTableQuestion {
  title?: string;
  caption?: string;
  hasHeaderRow?: boolean;
  headers?: string[];
  rows: TableCellConfig[][];
}

export interface ExplanationTable {
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface ExplanationComparison {
  title?: string;
  firstLabel: string;
  firstValue: string;
  secondLabel: string;
  secondValue: string;
  verdict?: string;
}

/** سؤال داخل "اختباراتي" — النصوص قد تحتوي رياضيات بصيغة $...$ */
export interface QuizQuestion {
  id: string;
  questionType?: QuestionKind;
  text: string;
  choices: string[];
  /** فهرس الإجابة الصحيحة (يبدأ من 0)، أو -1 إن لم تُحدد أو كان السؤال جدولاً */
  correctIndex: number;
  answer: string;
  explanation: string;
  table?: QuizTableQuestion;
  chart?: QuizChart;
  figure?: QuizFigure;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
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
  questionType?: QuestionKind;
  text: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  table?: QuizTableQuestion;
  chart?: QuizChart;
  figure?: QuizFigure;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
}

export interface QuizAttempt {
  id: string;
  ownerId: string;
  title: string;
  settings: ExamSettings;
  questions: ExamQuestion[];
  /** الخيار المختار لكل سؤال (-1 = بلا إجابة؛ لسؤال الجدول 1 = صحيح، 0 = خطأ، -1 = ناقص) */
  answers: number[];
  /** إجابات خلايا الجدول لكل سؤال مفهرسة برقم السؤال ثم "row_col" */
  tableAnswers?: Record<string, Record<string, string>>;
  score: number;
  total: number;
  durationSec: number;
  /** وقت الانتهاء بالملي ثانية (يبقى ثابتاً عند النقل بين القواعد) */
  finishedAt: number;
  createdAt?: unknown;
}

export interface StarredQuestion {
  id: string;
  ownerId: string;
  sourceQuizId?: string;
  sourceTitle?: string;
  question: QuizQuestion;
  starredAt: number;
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

/* ===================== إدارة المبرمجين وقواعد البيانات (اللاعبين + الاحتياطية) ===================== */

export type DatabaseRole = 'player' | 'backup';

export interface PoolFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
}

export interface DatabaseVerificationSummary {
  firestoreReady: boolean;
  googleAuthReady: boolean;
  rulesReady: boolean;
  verifiedAt: number;
  verifiedByEmail?: string;
}

export interface RegisteredDatabaseEntry {
  id: string;
  order: number;
  role: DatabaseRole;
  label: string;
  config: PoolFirebaseConfig;
  verification: DatabaseVerificationSummary;
  lastUsedAt?: number | null;
  lastAnnouncedToProjectId?: string | null;
  addedByEmail?: string;
  addedAt: number;
}

export interface ProgrammerMember {
  id: string;
  fullNameQuad: string;
  email?: string;
  isMaster?: boolean;
  promotedBy?: string;
  promotedAt: number;
}

export interface BackupAnnouncementInfo {
  backupDbId: string;
  backupProjectId: string;
  targetProjectId: string;
  targetConfig: PoolFirebaseConfig;
  migratedRoomId?: string | null;
  announcedAt: number;
  announcedByEmail?: string;
}

export interface PlatformProgrammerState {
  revision: number;
  playerDatabases: RegisteredDatabaseEntry[];
  backupDatabases: RegisteredDatabaseEntry[];
  activeTargetConfig: PoolFirebaseConfig;
  activePlayerDatabaseId: string | null;
  lastBackupAnnouncement: BackupAnnouncementInfo | null;
  programmers: ProgrammerMember[];
  migratedRoomId?: string | null;
  updatedByEmail?: string;
  updatedAt: number;
}
