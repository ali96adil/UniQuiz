import type {
  CompetitionSetupSnapshot,
  QuestionAllocationSummary,
  QuestionBankSummary,
} from "./index.js";

export const SETUP_STEP_IDS = [
  "identity",
  "participants",
  "questions",
  "draw",
  "readiness",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupStepStatus = "complete" | "pending" | "review";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  summary: string;
  status: SetupStepStatus;
  hint: string;
}

export interface SetupJourneyState {
  steps: SetupStep[];
  suggestedStep: SetupStepId;
  completedCount: number;
}

/**
 * Progress is a UI guide, not an authority to start a live competition.
 * Only the server's /api/operations/preflight can certify event-day readiness.
 */
export function getSetupJourney(
  competition: CompetitionSetupSnapshot,
  questionBank: QuestionBankSummary | null,
  allocation: QuestionAllocationSummary | null,
  eventTitle: string | null,
): SetupJourneyState {
  const participants = competition.participantCollegeIds.length;
  const selectedCategoryCount = allocation?.categories.filter(
    (category) => category.quotaPerRound > 0 || category.requiredQuestions > 0,
  ).length ?? 0;
  const rounds = competition.rounds.length;
  const questionTotal = questionBank?.totalQuestions ?? 0;
  const hasIdentity = Boolean(eventTitle?.trim());
  const participantsReady = participants >= 2 && competition.participantsLocked;
  const bankReady = questionTotal > 0 && selectedCategoryCount > 0;
  const drawReady = competition.drawCreatedAt !== null && rounds > 0;
  const allocated = drawReady && allocation?.ready === true;

  const steps: SetupStep[] = [
    {
      id: "identity",
      title: "المسابقة والهوية",
      summary: "اسم المسابقة، نوع المشاركين، الرعاية والشعارات",
      status: hasIdentity ? "complete" : "pending",
      hint: hasIdentity ? "العنوان محفوظ؛ راجع الرعاية والهوية قبل العرض." : "أدخل عنواناً للمسابقة واحفظ إعدادات العرض.",
    },
    {
      id: "participants",
      title: "المشاركون",
      summary: "إضافة الكليات أو الفرق واختيار المشاركين وتثبيتهم",
      status: participantsReady ? "complete" : "pending",
      hint: participants < 2
        ? "اختر مشاركين اثنين على الأقل."
        : competition.participantsLocked
          ? "المشاركون مثبتون ويمكن إجراء القرعة."
          : "ثبّت المشاركين بعد التأكد من الأسماء.",
    },
    {
      id: "questions",
      title: "الأسئلة والقواعد",
      summary: "بنك الأسئلة، المحاور، عدد الأسئلة، الوقت والنقاط",
      status: bankReady ? "complete" : "pending",
      hint: questionTotal === 0
        ? "استورد الأسئلة إلى البنك المشترك أولاً."
        : selectedCategoryCount === 0
          ? "اختر محوراً واحداً على الأقل وحدد عدد الأسئلة."
          : "القواعد قابلة للمراجعة؛ سيُفحص المخزون الفعلي بعد القرعة.",
    },
    {
      id: "draw",
      title: "القرعة والجولات",
      summary: "سحب المواجهات وتخصيص أسئلة كل جولة",
      status: drawReady ? "complete" : "pending",
      hint: drawReady
        ? `تم إنشاء ${rounds} جولة. راجع توزيع المحاور في كل جولة.`
        : participantsReady
          ? "أنشئ القرعة الرسمية ثم خصّص أسئلة كل جولة."
          : "ثبّت المشاركين أولاً قبل إنشاء القرعة.",
    },
    {
      id: "readiness",
      title: "التوزيع والجاهزية",
      summary: "قفل أسئلة الجولات، النسخة الاحتياطية وفحص يوم الحدث",
      status: allocated ? "review" : "pending",
      hint: !drawReady
        ? "تحتاج إلى قرعة قبل توزيع الأسئلة."
        : !allocated
          ? "تحقق من عدد الأسئلة المطلوبة، ثم وزّعها واقفلها."
          : "الأسئلة موزعة. افحص المحطات والشاشة وOSC والنسخة الاحتياطية قبل التشغيل.",
    },
  ];
  const suggestedStep = steps.find((step) => step.status === "pending")?.id ?? "readiness";
  return {
    steps,
    suggestedStep,
    completedCount: steps.filter((step) => step.status === "complete").length,
  };
}
