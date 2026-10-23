import { useMemo, useState, type ReactNode } from "react";
import {
  SETUP_STEP_IDS,
  getSetupJourney,
  type CompetitionSetupSnapshot,
  type QuestionAllocationSummary,
  type QuestionBankSummary,
  type SetupStepId,
} from "@uniquiz/shared";

type StepPanels = Record<SetupStepId, ReactNode>;

function initialStep(fallback: SetupStepId): SetupStepId {
  const selected = new URLSearchParams(window.location.search).get("step");
  return SETUP_STEP_IDS.find((id) => id === selected) ?? fallback;
}

export function SetupJourney({
  competition,
  questionBank,
  allocation,
  eventTitle,
  panels,
}: {
  competition: CompetitionSetupSnapshot;
  questionBank: QuestionBankSummary | null;
  allocation: QuestionAllocationSummary | null;
  eventTitle: string | null;
  panels: StepPanels;
}) {
  const progress = useMemo(() =>
    getSetupJourney(competition, questionBank, allocation, eventTitle),
    [competition, questionBank, allocation, eventTitle],
  );
  const [activeStep, setActiveStep] = useState<SetupStepId>(() =>
    initialStep("identity"),
  );
  const [showAll, setShowAll] = useState(false);
  const selectedIndex = SETUP_STEP_IDS.indexOf(activeStep);
  const selected = progress.steps[selectedIndex]!;

  const goTo = (id: SetupStepId) => {
    setActiveStep(id);
    setShowAll(false);
    const next = new URL(window.location.href);
    next.searchParams.set("step", id);
    window.history.replaceState(window.history.state, "", next.pathname + next.search + next.hash);
    document.getElementById("setup-journey")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <div className="setup-journey" id="setup-journey" dir="rtl">
      <section className="setup-journey-head" aria-label="مراحل إعداد المسابقة">
        <div className="setup-journey-headline">
          <div>
            <p className="eyebrow">UniQuiz · Competition Setup</p>
            <h2>إعداد البطولة خطوة بخطوة</h2>
            <p className="muted">
              كل مرحلة تحفظ إعداداتها داخل المسابقة الحالية. تگدر تنتقل بين المراحل
              بأي وقت، ومراجعة الجاهزية النهائية قبل بدء التشغيل.
            </p>
          </div>
          <div className="setup-journey-head-actions">
            <button
              type="button"
              className="setup-journey-toggle"
              onClick={() => goTo(progress.suggestedStep)}
            >
              تابع المرحلة المطلوبة
            </button>
            <button
              type="button"
              className="setup-journey-toggle"
              onClick={() => setShowAll((previous) => !previous)}
              aria-pressed={showAll}
            >
              {showAll ? "العرض الموجّه" : "عرض جميع الإعدادات"}
            </button>
          </div>
        </div>
        <div className="setup-journey-track" aria-label="تقدّم إعداد المسابقة">
          {progress.steps.map((step, index) => (
            <button
              type="button"
              key={step.id}
              className={[
                "setup-journey-step",
                activeStep === step.id && !showAll ? "is-current" : "",
                step.status === "complete" ? "is-complete" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => goTo(step.id)}
              aria-current={activeStep === step.id && !showAll ? "step" : undefined}
              aria-label={`المرحلة ${index + 1}: ${step.title}`}
            >
              <span className="setup-journey-number">
                {step.status === "complete" ? "✓" : index + 1}
              </span>
              <span className="setup-journey-step-copy">
                <strong>{step.title}</strong>
                <small>{step.status === "complete"
                  ? "البيانات الأولية مكتملة"
                  : step.status === "review"
                    ? "فحص التشغيل مطلوب"
                    : "بانتظار الإكمال"}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="setup-journey-progress">
          {progress.completedCount} من 4 مراحل إعداد مكتملة. فحص الجاهزية التشغيلية مستقل
          ولا يُعتبر ناجحاً إلا بعد ظهور READY في الفحص الفعلي.
        </p>
      </section>

      {showAll ? (
        <div className="setup-journey-all">
          {progress.steps.map((step, index) => (
            <section className="setup-journey-stage" key={step.id} aria-labelledby={`setup-heading-${step.id}`}>
              <header className="setup-journey-stage-heading">
                <p className="step-label">المرحلة {index + 1}</p>
                <h2 id={`setup-heading-${step.id}`}>{step.title}</h2>
                <p>{step.summary}</p>
                <small>{step.hint}</small>
              </header>
              {panels[step.id]}
            </section>
          ))}
        </div>
      ) : (
        <section className="setup-journey-stage" aria-labelledby="setup-active-heading">
          <header className="setup-journey-stage-heading">
            <p className="step-label">المرحلة {selectedIndex + 1} من 5</p>
            <h2 id="setup-active-heading">{selected.title}</h2>
            <p>{selected.summary}</p>
            <small>{selected.hint}</small>
          </header>
          {panels[activeStep]}
          <div className="setup-journey-navigation">
            <button type="button" disabled={selectedIndex === 0}
              onClick={() => goTo(SETUP_STEP_IDS[selectedIndex - 1]!)}>
              المرحلة السابقة
            </button>
            {selectedIndex < SETUP_STEP_IDS.length - 1 ? (
              <button type="button" className="primary"
                onClick={() => goTo(SETUP_STEP_IDS[selectedIndex + 1]!)}>
                المرحلة التالية ←
              </button>
            ) : (
              <a className="button-link" href="/operator">
                الانتقال إلى لوحة التشغيل
              </a>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
