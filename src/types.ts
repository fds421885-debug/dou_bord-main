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
export type RoomMode = 'quiz' | 'explain';

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
}

export interface SavedBoardSnapshot {
  studentId: string;
  studentName: string;
  strokes: Stroke[];
  submitted: boolean;
  verdict: BoardVerdict;
}

export interface SavedQuestion {
  id: string;
  ownerId: string;
  orderIndex: number;
  text: string;
  imageData: string;
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
