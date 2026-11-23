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
  laws?: string[];
  table?: QuizTableQuestion;
  chart?: QuizChart;
  figure?: QuizFigure;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
  redeemsFingerprint?: string;
}

export type DrillStyle = 'same_values' | 'same_law_ideas' | 'mixed';

export interface MyQuiz {
  id: string;
  ownerId: string;
  title: string;
  questions: QuizQuestion[];
  questionCount: number;
  parentQuizId?: string;
  quizKind?: 'main' | 'drill';
  drillStyle?: DrillStyle;
  sourceStarredId?: string;
  ruleTitle?: string;
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
  showLaws?: boolean;
  /** تجنب تكرار الأسئلة التي ظهرت في المحاولات السابقة حتى إكمال الدورة ثم يعيد تلقائياً */
  avoidRepeats?: boolean;
  /** وضع تصحيح الأخطاء السابقة: يحول الخطأ السابق إلى إجابة صحيحة دون تضخيم الإجمالي */
  mistakeReviewMode?: boolean;
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
  laws?: string[];
  table?: QuizTableQuestion;
  chart?: QuizChart;
  figure?: QuizFigure;
  explanationChart?: QuizChart;
  explanationFigure?: QuizFigure;
  explanationTable?: ExplanationTable;
  explanationComparison?: ExplanationComparison;
  redeemsFingerprint?: string;
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

/* ===================== لوحة الشرف والأصدقاء والمحادثات ===================== */

export interface LeaderboardTimeSlotSnapshot {
  id: string;
  label: string;
  rangeLabel: string;
  attempts: number;
  questions: number;
  correct: number;
  wrong: number;
  avgPct: number;
  avgSecPerQ: number;
  isBest: boolean;
}

export interface LeaderboardWeekdaySnapshot {
  dayIndex: number;
  label: string;
  attempts: number;
  questions: number;
  correct: number;
  avgPct: number;
  isBest: boolean;
}

export interface LeaderboardPointSnapshot {
  index: number;
  title: string;
  finishedAt: number;
  dateLabel: string;
  timeLabel: string;
  pct: number;
  movingAvgPct: number;
  correct: number;
  wrong: number;
  total: number;
  durationSec: number;
  secPerQ: number;
}

export interface LeaderboardQuizRowSnapshot {
  key: string;
  title: string;
  attempts: number;
  questions: number;
  correct: number;
  wrong: number;
  avgPct: number;
  bestPct: number;
  latestPct: number;
  deltaPct: number;
  avgSecPerQ: number;
}

export interface LeaderboardStatsSnapshot {
  accuracyPct: number;
  skippedAnswers: number;
  bestPct: number;
  worstPct: number;
  latestPct: number;
  volatilityStdDev: number;
  rangePct: number;
  stabilityLabel: 'مستقر جداً' | 'تذبذب متوسط' | 'تذبذب مرتفع' | 'غير كافٍ للقياس';
  trendDirection: 'up' | 'down' | 'flat';
  trendDeltaPct: number;
  avgSecPerQuestion: number;
  totalDurationSec: number;
  currentHighStreak: number;
  bestHighStreak: number;
  bestTimeSlotLabel: string | null;
  bestWeekdayLabel: string | null;
  timeSlots: LeaderboardTimeSlotSnapshot[];
  weekdays: LeaderboardWeekdaySnapshot[];
  recentPoints: LeaderboardPointSnapshot[];
  quizRows: LeaderboardQuizRowSnapshot[];
  typeBreakdown: {
    mcqTotal: number;
    mcqCorrect: number;
    tableTotal: number;
    tableCorrect: number;
    withLawsTotal: number;
    withLawsCorrect: number;
  };
}

export interface LeaderboardUserEntry {
  uid: string;
  fullNameQuad: string;
  epoch: number;
  correctCount: number;
  wrongCount: number;
  totalQuestions: number;
  attemptsCount: number;
  statsSnapshot: LeaderboardStatsSnapshot;
  joinedAt: number;
  updatedAt?: unknown;
}

export interface LeaderboardMetaDoc {
  id: 'leaderboardMeta';
  resetEpoch: number;
  updatedBy: string;
  updatedByName: string;
  updatedAt?: unknown;
}

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';

export interface FriendRequestDoc {
  id: string;
  fromUid: string;
  fromName: string;
  toUid: string;
  toName: string;
  status: FriendRequestStatus;
  createdAtMs: number;
  updatedAt?: unknown;
}

export interface FriendshipDoc {
  id: string;
  uids: string[];
  names: Record<string, string>;
  createdBy: string;
  createdAtMs: number;
  updatedAt?: unknown;
}

export interface SharedQuizSummaryMeta {
  sharedQuizDocId: string;
  quizTitle: string;
  questionCount: number;
  senderName: string;
}

export interface DirectChatDoc {
  id: string;
  participantIds: string[];
  participantNames: Record<string, string>;
  lastMessageText: string;
  lastMessageType: 'text' | 'quiz_share' | 'init';
  lastSenderId: string;
  lastSenderName: string;
  lastMessageAtMs: number;
  readAtMsByUid: Record<string, number>;
  updatedAt?: unknown;
}

export interface DirectMessageDoc {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  participantIds?: string[];
  type: 'text' | 'quiz_share';
  text: string;
  quizShare?: SharedQuizSummaryMeta;
  createdAtMs: number;
  createdAt?: unknown;
}

export interface SharedFriendQuizDoc {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  title: string;
  questions: QuizQuestion[];
  questionCount: number;
  createdAtMs: number;
  createdAt?: unknown;
}

export interface InAppNotificationToast {
  id: string;
  kind: 'message' | 'quiz_share' | 'friend_request';
  senderUid: string;
  senderName: string;
  title: string;
  body: string;
  createdAtMs: number;
  chatId?: string;
}

/* ===================== المساعد الذكي وتقويم المهارات البنائية ===================== */

export type FoundationalStageStatus = 'locked' | 'active' | 'completed';

export interface FoundationalStage {
  id: string;
  order: number;
  title: string;
  objective: string;
  coreConcept: string;
  sampleRule: string;
  targetScorePct: number;
  status: FoundationalStageStatus;
  bestScorePct?: number;
  attemptsCount?: number;
  quizId?: string;
}

export interface FoundationalPlan {
  id: string;
  sectionKey: string;
  sectionTitle: string;
  focusTopic: string;
  reason: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  stages: FoundationalStage[];
}

export interface CoachMemory {
  studentPreferredName?: string;
  personalityNotes: string[];
  learningGoals: string[];
  weakFocusHistory: string[];
  customFacts: string[];
  updatedAt: number;
}

export interface CoachTopicStat {
  key: string;
  title: string;
  sectionKey: string;
  sectionTitle: string;
  totalQuestions: number;
  correctCount: number;
  wrongCount: number;
  accuracyPct: number;
  avgSecPerQ: number;
  speedStatus: 'fast' | 'balanced' | 'slow';
  strengthStatus: 'strong' | 'developing' | 'weak';
  recentTrend: 'up' | 'down' | 'flat';
  remedialAttempts: number;
  lastRemedialPct?: number;
  needsFoundationalPlan: boolean;
}

export interface CoachQuickQuiz {
  id: string;
  title: string;
  topic: string;
  questions: QuizQuestion[];
  completedScore?: number;
  completedTotal?: number;
  completedDurationSec?: number;
  completedAt?: number;
}

export interface CoachChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAtMs: number;
  quickQuiz?: CoachQuickQuiz;
}

export interface CoachDiagnosisResult {
  generatedAt: number;
  summaryHeadline: string;
  encouragementNote: string;
  strengths: Array<{ title: string; detail: string; accuracyPct: number }>;
  weaknesses: Array<{
    title: string;
    sectionKey: string;
    sectionTitle: string;
    detail: string;
    accuracyPct: number;
  }>;
  slowAreas: Array<{ title: string; avgSecPerQ: number; advice: string }>;
  recommendedSectionKey: string;
  recommendedSectionTitle: string;
  recommendedFocusReason: string;
  suggestedPlan?: {
    focusTopic: string;
    reason: string;
    stages: Array<{
      title: string;
      objective: string;
      coreConcept: string;
      sampleRule: string;
    }>;
  } | null;
}

export interface CoachSectionProgress {
  sectionKey: string;
  sectionTitle: string;
  drillsCompleted: number;
  lastScorePct?: number;
  lastDurationSec?: number;
  mastered: boolean;
  repeatedLowCount: number;
  updatedAt: number;
}

export interface CoachStateDoc {
  id: 'state';
  ownerId: string;
  memory: CoachMemory;
  diagnosis: CoachDiagnosisResult | null;
  activeFoundationalPlan: FoundationalPlan | null;
  completedPlansCount: number;
  sectionProgress: Record<string, CoachSectionProgress>;
  chatMessages: CoachChatMessage[];
  updatedAt: number;
}


