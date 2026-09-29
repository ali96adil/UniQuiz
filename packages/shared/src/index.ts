export const CLIENT_ROLES = [
  "operator",
  "display",
  "team-a",
  "team-b",
  "unknown",
] as const;

export type ClientRole = (typeof CLIENT_ROLES)[number];

export const AUDIENCE_STATES = [
  "WELCOME",
  "DRAW_INTRO",
  "DRAW_ACTIVE",
  "DRAW_COMPLETE",
  "ROUND_INTRO",
  "QUESTION_READY",
  "QUESTION_COUNTDOWN",
  "QUESTION_ACTIVE",
  "QUESTION_CLOSED",
  "QUESTION_REVEAL",
  "BETWEEN_QUESTIONS",
  "ROUND_COMPLETE",
  "NEXT_ROUND",
  "INTERMISSION",
  "FINAL_RESULTS",
] as const;

export type AudienceState = (typeof AUDIENCE_STATES)[number];

export interface StationPresence {
  role: ClientRole;
  connected: boolean;
  connections: number;
}

export interface PresenceSnapshot {
  generatedAt: string;
  stations: StationPresence[];
}

export interface College {
  id: number;
  name: string;
  shortName: string | null;
  sortOrder: number;
}

export type QualificationRoundStatus =
  | "PENDING"
  | "ACTIVE"
  | "COMPLETED";

export interface QualificationRound {
  id: number;
  order: number;
  status: QualificationRoundStatus;
  collegeA: College;
  collegeB: College | null;
}

export type NextRoundSelectionMode = "DRAW_ORDER" | "MANUAL";

export interface CompetitionSetupSnapshot {
  colleges: College[];
  participantCollegeIds: number[];
  participantsLocked: boolean;
  drawCreatedAt: string | null;
  rounds: QualificationRound[];
  nextRoundId: number | null;
  nextRoundSelectionMode: NextRoundSelectionMode;
}

export interface DrawPresentationEvent {
  startedAt: string;
  rounds: QualificationRound[];
}

export type ImportDataKind = "colleges" | "categories" | "questions";

export interface ImportIssue {
  level: "error" | "warning";
  sheet: string;
  row: number | null;
  message: string;
}

export interface BulkImportPreview {
  previewId: string;
  fileName: string;
  valid: boolean;
  kinds: ImportDataKind[];
  counts: {
    colleges: number;
    categories: number;
    questions: number;
    participatingColleges: number;
  };
  categoryQuestionCounts: Record<string, number>;
  issues: ImportIssue[];
  samples: {
    colleges: string[];
    categories: string[];
    questions: string[];
  };
}

export interface QuestionBankSummary {
  totalQuestions: number;
  categories: Array<{
    key: string;
    name: string;
    sortOrder: number;
    questionCount: number;
  }>;
}

export interface QuestionAllocationCategorySummary {
  key: string;
  name: string;
  availableQuestions: number;
  requiredQuestions: number;
}

export interface RoundQuestionSetSummary {
  roundId: number;
  roundOrder: number;
  locked: boolean;
  questionCount: number;
  categoryCounts: Record<string, number>;
}

export interface QuestionAllocationSummary {
  roundCount: number;
  questionsPerRound: number;
  requiredPerCategory: number;
  ready: boolean;
  categories: QuestionAllocationCategorySummary[];
  rounds: RoundQuestionSetSummary[];
}

export type LivePhase =
  | "IDLE"
  | "ROUND_READY"
  | "ROUND_ACTIVE"
  | "QUESTION_READY"
  | "QUESTION_COUNTDOWN"
  | "QUESTION_ACTIVE"
  | "QUESTION_CLOSED"
  | "QUESTION_REVEAL"
  | "INTERMISSION"
  | "ROUND_COMPLETE";

export interface LiveQuestionView {
  position: number;
  categoryKey: string;
  categoryName: string;
  prompt: string | null;
  options: {
    A: string;
    B: string;
    C: string;
    D: string;
  } | null;
  correctOption: "A" | "B" | "C" | "D" | null;
}

export interface LiveRoundView {
  id: number;
  order: number;
  teamA: College;
  teamB: College | null;
}

export interface LiveSnapshot {
  phase: LivePhase;
  serverNowEpochMs: number;
  round: LiveRoundView | null;
  stationsConfirmed: boolean;
  question: LiveQuestionView | null;
  countdownStartedAtEpochMs: number | null;
  questionStartedAtEpochMs: number | null;
  questionDeadlineEpochMs: number | null;
  questionClosedAtEpochMs: number | null;
  closeReason: string | null;
  hasPendingRound: boolean;
  qualificationComplete: boolean;
  stationReadiness: LiveStationReadiness;
  answerStatus: LiveAnswerStatus;
  revealResults: LiveRevealResults | null;
}

export interface LiveAnswerStatus {
  teamARequired: boolean;
  teamAReceived: boolean;
  teamBRequired: boolean;
  teamBReceived: boolean;
}

export interface LiveTeamSubmissionState {
  station: "A" | "B";
  required: boolean;
  locked: boolean;
  selectedOption: "A" | "B" | "C" | "D" | null;
  submittedAtEpochMs: number | null;
  responseTimeMs: number | null;
}

export interface LiveSubmissionReceipt {
  station: "A" | "B";
  selectedOption: "A" | "B" | "C" | "D";
  submittedAtEpochMs: number;
  responseTimeMs: number;
}

export interface LiveStationReadiness {
  teamARequired: boolean;
  teamAConnected: boolean;
  teamBRequired: boolean;
  teamBConnected: boolean;
}

export interface LiveRevealTeamResult {
  station: "A" | "B";
  answered: boolean;
  selectedOption: "A" | "B" | "C" | "D" | null;
  isCorrect: boolean | null;
  responseTimeMs: number | null;
  scorePoints: number;
}

export interface LiveRevealResults {
  teamA: LiveRevealTeamResult;
  teamB: LiveRevealTeamResult | null;
}

export type QualificationRankingStatus =
  | "PLAYING"
  | "COMPLETED"
  | "NOT_STARTED";

export interface QualificationRankingEntry {
  college: College;
  status: QualificationRankingStatus;
  rank: number | null;
  scorePoints: number;
  revealedQuestions: number;
}

export interface QualificationRankingSnapshot {
  generatedAt: string;
  entries: QualificationRankingEntry[];
}
