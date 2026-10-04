import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { io } from "socket.io-client";
import type {
  AudienceDisplaySettings,
  AudiencePresentationSnapshot,
  BulkImportPreview,
  ClientRole,
  CompetitionSetupSnapshot,
  DrawPresentationEvent,
  LiveSnapshot,
  LiveTeamSubmissionState,
  OperationsDiagnosticsSnapshot,
  OperationsPreflightSnapshot,
  QualificationRankingSnapshot,
  PresenceSnapshot,
  QualificationRound,
  QuestionAllocationSummary,
  QuestionBankSummary,
  RuntimeMode,
  StationPresence,
} from "@uniquiz/shared";

type Surface =
  | "home"
  | "setup"
  | "draw"
  | "operator"
  | "display"
  | "report"
  | "stations"
  | "team-a"
  | "team-b";

const surfaceTitles: Record<Surface, string> = {
  home: "مسابقة بنك المعلومات",
  setup: "إعداد المسابقة",
  draw: "القرعة",
  operator: "لوحة التحكم",
  display: "شاشة الجمهور",
  report: "بيان النتائج الرسمي",
  stations: "بوابة المحطات",
  "team-a": "محطة المتسابق A",
  "team-b": "محطة المتسابق B",
};

const PATRONAGE_LINE =
  "برعاية السيد رئيس جامعة بابل الأستاذ الدكتور أمين عجيل ياسر الياسري المحترم";
const SUPERVISION_LINE =
  "وإشراف الأستاذ الدكتور ميثاق طالب عبد الجبوري مساعد رئيس الجامعة للشؤون الإدارية المحترم";

const roleTitles: Record<ClientRole, string> = {
  operator: "Operator",
  display: "Display",
  "team-a": "Team A",
  "team-b": "Team B",
  unknown: "Unknown",
};

function surfaceFromPath(pathname: string): Surface {
  if (pathname.startsWith("/setup")) return "setup";
  if (pathname.startsWith("/draw")) return "draw";
  if (pathname.startsWith("/operator")) return "operator";
  if (pathname.startsWith("/report")) return "report";
  if (pathname === "/s" || pathname.startsWith("/stations")) return "stations";
  if (pathname.startsWith("/display")) return "display";
  if (pathname.startsWith("/team/a")) return "team-a";
  if (pathname.startsWith("/team/b")) return "team-b";
  return "home";
}

function roleForSurface(surface: Surface): ClientRole {
  switch (surface) {
    case "setup":
    case "draw":
    case "operator":
    case "report":
      return "operator";
    case "display":
      return "display";
    case "team-a":
      return "team-a";
    case "team-b":
      return "team-b";
    default:
      return "unknown";
  }
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as
    | T
    | { error?: string; message?: string };

  if (!response.ok) {
    const problem = payload as { error?: string; message?: string };
    throw new Error(
      problem.message ??
        problem.error ??
        `HTTP ${response.status}`,
    );
  }

  return payload as T;
}

function PresenceCard({ station }: { station: StationPresence }) {
  return (
    <div className="presence-card">
      <span>{roleTitles[station.role]}</span>
      <strong className={station.connected ? "online" : "offline"}>
        {station.connected ? `متصل (${station.connections})` : "غير متصل"}
      </strong>
    </div>
  );
}

function audienceText(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) =>
      result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

function StatusMessage({
  error,
  message,
}: {
  error: string | null;
  message: string | null;
}) {
  if (!error && !message) return null;

  return (
    <div className={error ? "status-message error" : "status-message success"}>
      {error ?? message}
    </div>
  );
}


function BulkImportPanel({
  questionBank,
}: {
  questionBank: QuestionBankSummary | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [questionMode, setQuestionMode] =
    useState<"append" | "replace">("append");

  const previewFile = async () => {
    if (!file) return;

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const form = new FormData();
      form.append("file", file);

      const response = await fetch("/api/import/preview", {
        method: "POST",
        body: form,
      });

      const payload = (await response.json()) as
        | BulkImportPreview
        | { error?: string; message?: string };

      if (!response.ok) {
        const problem = payload as {
          error?: string;
          message?: string;
        };
        throw new Error(
          problem.message ?? problem.error ?? `HTTP ${response.status}`,
        );
      }

      setPreview(payload as BulkImportPreview);
    } catch (caught) {
      setPreview(null);
      setError(
        caught instanceof Error ? caught.message : "تعذر قراءة الملف",
      );
    } finally {
      setBusy(false);
    }
  };

  const applyImport = async () => {
    if (!preview?.valid) return;

    const importsQuestions =
      preview.kinds.includes("questions");
    const importsCategories =
      preview.kinds.includes("categories");
    const effectiveQuestionMode =
      importsQuestions && importsCategories
        ? "replace"
        : questionMode;

    if (
      importsQuestions &&
      effectiveQuestionMode === "replace" &&
      !window.confirm(
        "استبدال بنك الأسئلة الحالي بالكامل؟ سيتم حذف الأسئلة الحالية قبل إدخال أسئلة الملف.",
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest("/api/import/apply", {
        method: "POST",
        body: JSON.stringify({
          previewId: preview.previewId,
          questionMode:
            preview.kinds.includes("questions") &&
            preview.kinds.includes("categories")
              ? "replace"
              : questionMode,
        }),
      });

      setMessage("تم اعتماد البيانات وحفظها في قاعدة UniQuiz.");
      setPreview(null);
      setFile(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "تعذر اعتماد الاستيراد",
      );
    } finally {
      setBusy(false);
    }
  };

  const errors =
    preview?.issues.filter((entry) => entry.level === "error") ?? [];
  const warnings =
    preview?.issues.filter((entry) => entry.level === "warning") ?? [];

  return (
    <section className="panel import-panel">
      <div className="section-heading">
        <div>
          <p className="step-label">الخطوة 1</p>
          <h2>إدخال البيانات</h2>
        </div>
        <div className="actions compact-actions">
          <a
            className="button-link"
            href="/api/import/template.xlsx"
            download
          >
            تحميل قالب Excel
          </a>
          <a
            className="button-link"
            href="/api/import/sample.xlsx"
            download
          >
            تحميل ملف اختبار Excel
          </a>
          <a
            className="button-link"
            href="/api/export/data.xlsx"
            download
          >
            تصدير البيانات الحالية
          </a>
        </div>
      </div>

      <p className="muted">
        ملف Excel يمكن أن يحتوي Sheets باسم Colleges وCategories وQuestions.
        ملف CSV يمثل نوع بيانات واحد في كل مرة.
      </p>

      <div className="import-schema">
        <div>
          <strong>Questions</strong>
          <code>
            category_key · question · option_a · option_b · option_c ·
            option_d · correct_option · source_ref
          </code>
          <small className="muted">
            category_key يقبل المفتاح الداخلي أو اسم المحور الظاهر، مثل
            «تاريخ» أو «جغرافيا».
          </small>
        </div>
        <div>
          <strong>Categories</strong>
          <code>key · name</code>
        </div>
        <div>
          <strong>Colleges</strong>
          <code>name · short_name · participating</code>
        </div>
      </div>

      <div className="import-upload">
        <input
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPreview(null);
            setError(null);
            setMessage(null);
            setQuestionMode("append");
          }}
        />
        <button
          className="primary"
          disabled={!file || busy}
          onClick={() => void previewFile()}
        >
          فحص الملف
        </button>
      </div>

      {preview ? (
        <div className="import-preview">
          <div className="section-heading">
            <div>
              <p className="step-label">Preview</p>
              <h3>{preview.fileName}</h3>
            </div>
            <span
              className={
                preview.valid ? "preview-state valid" : "preview-state invalid"
              }
            >
              {preview.valid ? "VALID" : "HAS ERRORS"}
            </span>
          </div>

          <div className="import-counts">
            <span>كليات: {preview.counts.colleges}</span>
            <span>مشاركة: {preview.counts.participatingColleges}</span>
            <span>محاور: {preview.counts.categories}</span>
            <span>أسئلة: {preview.counts.questions}</span>
          </div>

          {Object.keys(preview.categoryQuestionCounts).length > 0 ? (
            <div className="category-counts">
              {Object.entries(preview.categoryQuestionCounts).map(
                ([key, count]) => (
                  <span key={key}>
                    {key}: {count}
                  </span>
                ),
              )}
            </div>
          ) : null}

          {errors.length > 0 ? (
            <div className="import-issues error-list">
              <strong>أخطاء يجب إصلاحها</strong>
              {errors.map((entry, index) => (
                <p key={index}>
                  {entry.sheet}
                  {entry.row ? ` — row ${entry.row}` : ""}: {entry.message}
                </p>
              ))}
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <div className="import-issues warning-list">
              <strong>تنبيهات</strong>
              {warnings.map((entry, index) => (
                <p key={index}>
                  {entry.sheet}
                  {entry.row ? ` — row ${entry.row}` : ""}: {entry.message}
                </p>
              ))}
            </div>
          ) : null}

          {preview.kinds.includes("questions") ? (
            preview.kinds.includes("categories") ? (
              <div className="import-mode-note">
                هذا الملف يحتوي Categories وQuestions؛ سيتم استبدال
                المحاور وبنك الأسئلة معًا عند الاعتماد.
              </div>
            ) : (
              <div className="import-mode">
                <strong>طريقة إدخال الأسئلة</strong>
                <label>
                  <input
                    type="radio"
                    name="question-import-mode"
                    checked={questionMode === "append"}
                    onChange={() => setQuestionMode("append")}
                  />
                  إضافة إلى بنك الأسئلة الحالي
                </label>
                <label>
                  <input
                    type="radio"
                    name="question-import-mode"
                    checked={questionMode === "replace"}
                    onChange={() => setQuestionMode("replace")}
                  />
                  استبدال بنك الأسئلة بالكامل
                </label>
              </div>
            )
          ) : null}

          <div className="import-samples">
            {preview.samples.colleges.length > 0 ? (
              <div>
                <strong>نماذج الكليات</strong>
                <p>{preview.samples.colleges.join(" · ")}</p>
              </div>
            ) : null}
            {preview.samples.categories.length > 0 ? (
              <div>
                <strong>المحاور</strong>
                <p>{preview.samples.categories.join(" · ")}</p>
              </div>
            ) : null}
            {preview.samples.questions.length > 0 ? (
              <div>
                <strong>نماذج الأسئلة</strong>
                <p>{preview.samples.questions.join(" · ")}</p>
              </div>
            ) : null}
          </div>

          <button
            className="primary large-button"
            disabled={!preview.valid || busy}
            onClick={() => void applyImport()}
          >
            اعتماد الاستيراد
          </button>
        </div>
      ) : null}

      {questionBank ? (
        <div className="question-bank-summary">
          <strong>بنك الأسئلة الحالي: {questionBank.totalQuestions} سؤال</strong>
          <div>
            {questionBank.categories.map((category) => (
              <span key={category.key}>
                {category.name}: {category.questionCount}
                <small> · key: {category.key}</small>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <StatusMessage error={error} message={message} />
    </section>
  );
}




function AudienceSettingsPanel({
  settings,
}: {
  settings: AudienceDisplaySettings | null;
}) {
  const [draft, setDraft] = useState<AudienceDisplaySettings | null>(
    settings,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  if (!draft) {
    return (
      <section className="panel">
        <h2>هوية شاشة الجمهور</h2>
        <p>بانتظار تحميل الإعدادات...</p>
      </section>
    );
  }

  const setField = (
    key:
      | "eventTitle"
      | "eventSubtitle"
      | "venue"
      | "season"
      | "footerText"
      | "roundLabel",
    value: string,
  ) => {
    setDraft((current) =>
      current ? { ...current, [key]: value } : current,
    );
  };

  const setCopyField = (
    key: Exclude<keyof AudienceDisplaySettings["copy"], "preShow">,
    value: string,
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            copy: {
              ...current.copy,
              [key]: value,
            },
          }
        : current,
    );
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest<AudienceDisplaySettings>(
        "/api/audience/settings",
        {
          method: "PUT",
          body: JSON.stringify({
            eventTitle: draft.eventTitle,
            eventSubtitle: draft.eventSubtitle,
            venue: draft.venue,
            season: draft.season,
            footerText: draft.footerText,
            roundLabel: draft.roundLabel,
            copy: draft.copy,
          }),
        },
      );
      setMessage("تم حفظ إعدادات شاشة الجمهور.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر حفظ إعدادات شاشة الجمهور",
      );
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = async (
    slot: "university" | "department",
    file: File | null,
  ) => {
    if (!file) return;

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const form = new FormData();
      form.append("file", file);

      const response = await fetch(
        `/api/audience/assets/${slot}`,
        {
          method: "POST",
          body: form,
        },
      );

      const payload = (await response.json()) as
        | AudienceDisplaySettings
        | { error?: string; message?: string };

      if (!response.ok) {
        const problem = payload as {
          error?: string;
          message?: string;
        };
        throw new Error(
          problem.message ??
            problem.error ??
            `HTTP ${response.status}`,
        );
      }

      setMessage("تم تحديث الشعار.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر رفع الشعار",
      );
    } finally {
      setBusy(false);
    }
  };

  const removeLogo = async (
    slot: "university" | "department",
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest<AudienceDisplaySettings>(
        `/api/audience/assets/${slot}`,
        { method: "DELETE" },
      );
      setMessage("تم حذف الشعار.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر حذف الشعار",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel audience-settings-panel">
      <div className="section-heading">
        <div>
          <p className="step-label">الخطوة 6</p>
          <h2>هوية شاشة الجمهور</h2>
        </div>
      </div>

      <div className="audience-settings-grid">
        <label>
          <span>عنوان المسابقة</span>
          <input
            value={draft.eventTitle}
            onChange={(event) =>
              setField("eventTitle", event.target.value)
            }
          />
        </label>
        <label>
          <span>العنوان الفرعي</span>
          <input
            value={draft.eventSubtitle}
            onChange={(event) =>
              setField("eventSubtitle", event.target.value)
            }
          />
        </label>
        <label>
          <span>المكان</span>
          <input
            value={draft.venue}
            onChange={(event) =>
              setField("venue", event.target.value)
            }
          />
        </label>
        <label>
          <span>الموسم / السنة</span>
          <input
            value={draft.season}
            onChange={(event) =>
              setField("season", event.target.value)
            }
          />
        </label>
        <label className="wide">
          <span>نص Footer</span>
          <input
            value={draft.footerText}
            onChange={(event) =>
              setField("footerText", event.target.value)
            }
          />
        </label>
        <label>
          <span>تسمية الجولة</span>
          <input
            value={draft.roundLabel}
            onChange={(event) =>
              setField("roundLabel", event.target.value)
            }
          />
        </label>
      </div>


      <details className="audience-copy-settings">
        <summary>نصوص شاشة الجمهور المتقدمة</summary>
        <p className="muted">
          يمكن استخدام المتغيرات {"{count}"} و{"{question}"} و{"{rank}"}
          في الحقول التي تحتويها افتراضيًا.
        </p>
        <div className="audience-settings-grid">
          {([
            ["welcomeTitle", "عنوان الترحيب"],
            ["waitingParticipantsText", "انتظار المشاركين"],
            ["drawPhaseLabel", "تسمية مرحلة القرعة"],
            ["drawOfficialTitle", "عنوان القرعة"],
            ["participatingCollegeCountText", "عدد الكليات المشاركة"],
            ["drawWaitingText", "انتظار إجراء القرعة"],
            ["drawPresentingKicker", "أثناء إعلان القرعة"],
            ["drawResultsKicker", "بعد إعلان القرعة"],
            ["roundsTitle", "عنوان الجولات"],
            ["versusLabel", "VS"],
            ["soloLabel", "SOLO"],
            ["soloRoundText", "الجولة الفردية"],
            ["drawPresentingFooter", "Footer أثناء القرعة"],
            ["drawCompleteFooter", "Footer بعد القرعة"],
            ["rankingTitle", "عنوان الترتيب"],
            ["rankingSubtitle", "وصف الترتيب"],
            ["playingStatus", "حالة يلعب الآن"],
            ["completedStatus", "حالة مكتملة"],
            ["notStartedStatus", "حالة لم تبدأ"],
            ["pointsLabel", "تسمية النقاط"],
            ["waitingRoundsText", "انتظار بدء الجولات"],
            ["waitingNextRoundText", "انتظار الجولة القادمة"],
            ["questionLabel", "تسمية السؤال"],
            ["questionReadyText", "رسالة السؤال الجاهز"],
            ["intermissionText", "رسالة الاستراحة"],
            ["roundReadyText", "رسالة الجولة الجاهزة"],
            ["closedLabel", "تسمية مغلق"],
            ["resultLabel", "تسمية النتيجة"],
            ["answerPrefix", "تسمية الإجابة"],
            ["correctStatus", "تسمية صحيحة"],
            ["wrongStatus", "تسمية غير صحيحة"],
            ["secondsLabel", "تسمية الثانية"],
            ["noAnswerText", "لم تتم الإجابة"],
            ["answerReceivedText", "تم استلام الإجابة"],
            ["waitingAnswerText", "بانتظار الإجابة"],
            ["correctAnswerLabel", "الإجابة الصحيحة"],
            ["optionLabel", "تسمية الخيار"],
            ["closedWaitingResultText", "إغلاق السؤال قبل النتيجة"],
            ["qualificationCompleteKicker", "انتهاء التصفيات"],
            ["finalRankingTitle", "عنوان الترتيب النهائي"],
            ["positionLabel", "تسمية المركز"],
            ["qualificationFinalText", "نص اعتماد نتائج التصفيات"],
            ["roundEndedPrefix", "بادئة انتهاء الجولة"],
            ["roundResultTitle", "عنوان نتيجة الجولة"],
            ["nextRoundTitle", "عنوان الجولة القادمة"],
            ["waitingNextRoundSelectionText", "انتظار تحديد الجولة القادمة"],
            ["teamALabel", "تسمية Team A"],
            ["teamBLabel", "تسمية Team B"],
          ] as Array<
            [
              Exclude<keyof AudienceDisplaySettings["copy"], "preShow">,
              string,
            ]
          >).map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                value={draft.copy[key]}
                onChange={(event) =>
                  setCopyField(key, event.target.value)
                }
              />
            </label>
          ))}
        </div>
      </details>

      <div className="audience-logo-grid">
        {([
          ["university", "شعار جامعة بابل", draft.universityLogoUrl],
          ["department", "شعار قسم النشاطات الطلابية", draft.departmentLogoUrl],
        ] as const).map(([slot, label, url]) => (
          <div className="audience-logo-card" key={slot}>
            <strong>{label}</strong>
            <div className="audience-logo-preview">
              {url ? (
                <img src={url} alt={label} />
              ) : (
                <span>لا يوجد شعار</span>
              )}
            </div>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(event) => {
                void uploadLogo(
                  slot,
                  event.target.files?.[0] ?? null,
                );
                event.currentTarget.value = "";
              }}
            />
            {url ? (
              <button
                className="danger-outline"
                disabled={busy}
                onClick={() => void removeLogo(slot)}
              >
                حذف الشعار
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void save()}
        >
          حفظ هوية العرض
        </button>
      </div>

      <StatusMessage error={error} message={message} />
    </section>
  );
}

function ResetAllCompetitionPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const resetAll = async () => {
    if (
      !window.confirm(
        "سيتم حذف جميع بيانات المسابقة الحالية: الكليات، المشاركون، القرعة، المحاور، الأسئلة، التوزيع، النتائج والترتيب. هل تريد المتابعة؟",
      )
    ) {
      return;
    }

    const typed = window.prompt(
      'للتأكيد النهائي اكتب RESET ثم اضغط موافق.',
      "",
    );

    if (typed !== "RESET") {
      setError("تم إلغاء المسح لأن كلمة التأكيد غير صحيحة.");
      setMessage(null);
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest("/api/setup/reset-all", {
        method: "POST",
        body: JSON.stringify({
          confirm: "RESET_ALL_COMPETITION_DATA",
        }),
      });

      setMessage(
        "تم مسح جميع بيانات المسابقة. النظام جاهز لإعداد مسابقة جديدة.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر مسح بيانات المسابقة",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel danger-zone">
      <div className="section-heading">
        <div>
          <p className="step-label">Danger Zone</p>
          <h2>بدء مسابقة من الصفر</h2>
        </div>
      </div>

      <p className="muted">
        يمسح الكليات والمشاركين والقرعة والمحاور والأسئلة وتوزيع الجولات
        والإجابات والنتائج والترتيب. لا يمس توكنات Station A/B ولا إعدادات
        تشغيل UniQuiz.
      </p>

      <button
        className="danger-button"
        disabled={busy}
        onClick={() => void resetAll()}
      >
        مسح كل بيانات المسابقة
      </button>

      <StatusMessage error={error} message={message} />
    </section>
  );
}

function QuestionAllocationPanel({
  allocation,
}: {
  allocation: QuestionAllocationSummary | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!allocation) return null;

  const inventoryReady =
    allocation.roundCount > 0 &&
    allocation.categories.length === 5 &&
    allocation.categories.every(
      (category) =>
        category.availableQuestions >= category.requiredQuestions,
    );

  const hasLockedSets = allocation.rounds.some((round) => round.locked);

  const run = async (
    path: string,
    confirm: string,
    successMessage: string,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({ confirm }),
      });
      setMessage(successMessage);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "حدث خطأ غير متوقع",
      );
    } finally {
      setBusy(false);
    }
  };

  const allocate = () => {
    if (
      !window.confirm(
        "توزيع وقفل 10 أسئلة لكل جولة الآن؟ سيتم استخدام سؤالين من كل محور ولن يتكرر أي سؤال بين الجولات.",
      )
    ) {
      return;
    }

    void run(
      "/api/question-bank/allocate",
      "ALLOCATE_QUESTIONS",
      "تم توزيع وقفل الأسئلة لكل الجولات.",
    );
  };

  const reset = () => {
    if (
      !window.confirm(
        "إلغاء جميع مجموعات الأسئلة المقفلة وإعادة فتح التوزيع؟ هذا متاح فقط قبل بدء أي جولة.",
      )
    ) {
      return;
    }

    void run(
      "/api/question-bank/allocation/reset",
      "RESET_QUESTION_SETS",
      "تمت إعادة ضبط توزيع الأسئلة.",
    );
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="step-label">الخطوة 5</p>
          <h2>توزيع أسئلة الجولات</h2>
        </div>
        <span
          className={
            allocation.ready
              ? "preview-state valid"
              : "preview-state invalid"
          }
        >
          {allocation.ready
            ? "READY"
            : allocation.roundCount === 0
              ? "بانتظار القرعة"
              : "NOT READY"}
        </span>
      </div>

      <p className="muted">
        لكل جولة 10 أسئلة: سؤالان من كل واحد من المحاور الخمسة، ومن دون
        تكرار أي سؤال في جولة أخرى.
      </p>

      <div className="allocation-categories">
        {allocation.categories.map((category) => {
          const enough =
            category.availableQuestions >= category.requiredQuestions;

          return (
            <div
              className={
                enough
                  ? "allocation-category enough"
                  : "allocation-category shortage"
              }
              key={category.key}
            >
              <strong>{category.name}</strong>
              <span>
                المتوفر {category.availableQuestions} /{" "}
                {allocation.roundCount === 0
                  ? "المطلوب يتحدد بعد القرعة"
                  : `المطلوب ${category.requiredQuestions}`}
              </span>
            </div>
          );
        })}
      </div>

      {allocation.roundCount === 0 ? (
        <div className="empty-state">
          أنشئ القرعة الرسمية أولاً حتى يعرف النظام عدد الجولات.
        </div>
      ) : null}

      <div className="round-allocation-grid">
        {allocation.rounds.map((round) => (
          <div
            className={
              round.locked
                ? "round-allocation locked"
                : "round-allocation"
            }
            key={round.roundId}
          >
            <strong>جولة {round.roundOrder}</strong>
            <span>{round.questionCount} / 10 سؤال</span>
            <small>
              {round.locked ? "مقفلة" : "غير موزعة"}
            </small>
          </div>
        ))}
      </div>

      <div className="actions">
        <button
          className="primary"
          disabled={
            busy ||
            !inventoryReady ||
            hasLockedSets ||
            allocation.ready
          }
          onClick={allocate}
        >
          توزيع وقفل الأسئلة
        </button>

        {hasLockedSets ? (
          <button
            className="danger-outline"
            disabled={busy}
            onClick={reset}
          >
            Reset توزيع الأسئلة
          </button>
        ) : null}
      </div>

      {!inventoryReady && allocation.roundCount > 0 ? (
        <p className="status-message error">
          بنك الأسئلة غير كافٍ لتوزيع سؤالين من كل محور على كل الجولات
          بدون تكرار.
        </p>
      ) : null}

      <StatusMessage error={error} message={message} />
    </section>
  );
}

function SetupSurface({
  snapshot,
}: {
  snapshot: CompetitionSetupSnapshot;
}) {
  const [collegeDrafts, setCollegeDrafts] = useState<string[]>(() =>
    Array.from({ length: 20 }, (_, index) =>
      snapshot.colleges[index]?.name ?? "",
    ),
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    () => new Set(snapshot.participantCollegeIds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setCollegeDrafts(
      Array.from({ length: 20 }, (_, index) =>
        snapshot.colleges[index]?.name ?? "",
      ),
    );
    setSelectedIds(new Set(snapshot.participantCollegeIds));
  }, [
    snapshot.colleges,
    snapshot.participantCollegeIds,
  ]);

  const locked = snapshot.participantsLocked || snapshot.drawCreatedAt !== null;

  const run = async (
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await action();
      setMessage(successMessage);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "حدث خطأ غير متوقع",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveColleges = () =>
    run(
      () =>
        apiRequest("/api/setup/colleges", {
          method: "PUT",
          body: JSON.stringify({
            colleges: collegeDrafts
              .map((name) => name.trim())
              .filter(Boolean)
              .map((name) => ({ name })),
          }),
        }),
      "تم حفظ قائمة الكليات.",
    );

  const persistParticipants = async (nextIds: Set<number>) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest("/api/setup/participants", {
        method: "PUT",
        body: JSON.stringify({
          collegeIds: [...nextIds],
        }),
      });
      setMessage("تم تحديث الكليات المشاركة مباشرةً على شاشة الجمهور.");
    } catch (caught) {
      setSelectedIds(new Set(snapshot.participantCollegeIds));
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر تحديث الكليات المشاركة",
      );
    } finally {
      setBusy(false);
    }
  };

  const lockParticipants = () =>
    run(
      () =>
        apiRequest("/api/setup/participants/lock", {
          method: "POST",
          body: "{}",
        }),
      "تم تثبيت المشاركين. أصبحت القرعة جاهزة.",
    );

  const unlockParticipants = () => {
    if (
      !window.confirm(
        "إلغاء تثبيت المشاركين؟ هذا متاح فقط قبل إنشاء القرعة.",
      )
    ) {
      return;
    }

    void run(
      () =>
        apiRequest("/api/setup/participants/unlock", {
          method: "POST",
          body: JSON.stringify({
            confirm: "UNLOCK_PARTICIPANTS",
          }),
        }),
      "تم إلغاء التثبيت ويمكن تعديل المشاركين.",
    );
  };

  const toggleParticipant = (collegeId: number) => {
    if (snapshot.participantsLocked || busy) return;

    const next = new Set(selectedIds);
    if (next.has(collegeId)) next.delete(collegeId);
    else next.add(collegeId);

    setSelectedIds(next);
    void persistParticipants(next);
  };

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="step-label">الخطوة 2</p>
            <h2>قائمة الكليات</h2>
          </div>
          <span className="counter">
            {snapshot.colleges.length} / 20
          </span>
        </div>

        <p className="muted">
          اكتب أسماء الكليات المستخدمة في هذه النسخة من المسابقة. يمكن
          استخدام أقل من 20 كلية وترك بقية الخانات فارغة.
        </p>

        <div className="college-input-grid">
          {collegeDrafts.map((value, index) => (
            <label className="college-input" key={index}>
              <span>{index + 1}</span>
              <input
                value={value}
                disabled={locked || busy}
                placeholder={`اسم الكلية ${index + 1}`}
                onChange={(event) => {
                  const next = [...collegeDrafts];
                  next[index] = event.target.value;
                  setCollegeDrafts(next);
                }}
              />
            </label>
          ))}
        </div>

        <div className="actions">
          <button
            className="primary"
            disabled={locked || busy}
            onClick={() => void saveColleges()}
          >
            حفظ قائمة الكليات
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="step-label">الخطوة 3</p>
            <h2>تحديد الكليات المشاركة</h2>
          </div>
          <span className="counter">{selectedIds.size} مختارة</span>
        </div>

        {snapshot.colleges.length === 0 ? (
          <p className="empty-state">
            احفظ قائمة الكليات أولاً.
          </p>
        ) : (
          <div className="participant-grid">
            {snapshot.colleges.map((college) => (
              <label
                className={
                  selectedIds.has(college.id)
                    ? "participant selected"
                    : "participant"
                }
                key={college.id}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(college.id)}
                  disabled={snapshot.participantsLocked || busy}
                  onChange={() => toggleParticipant(college.id)}
                />
                <span>{college.name}</span>
              </label>
            ))}
          </div>
        )}

        {!snapshot.participantsLocked &&
        snapshot.colleges.length > 0 ? (
          <p className="live-sync-note">
            كل تحديد أو إلغاء تحديد يُحفظ فورًا ويظهر مباشرةً على شاشة الجمهور.
          </p>
        ) : null}

        <div className="actions">
          {!snapshot.participantsLocked ? (
            <button
              className="primary"
              disabled={
                selectedIds.size < 2 || busy
              }
              onClick={() => void lockParticipants()}
            >
              تثبيت المشاركين
            </button>
          ) : (
            <button
              className="danger-outline"
              disabled={snapshot.drawCreatedAt !== null || busy}
              onClick={unlockParticipants}
            >
              إلغاء التثبيت
            </button>
          )}
        </div>

        {snapshot.participantsLocked ? (
          <p className="locked-note">
            ✓ تم تثبيت المشاركين. أي تعديل يتطلب إلغاء التثبيت قبل
            إنشاء القرعة.
          </p>
        ) : null}

        <StatusMessage error={error} message={message} />
      </section>
    </>
  );
}

function RoundCard({
  round,
  isNext,
  selectionMode,
  onSelect,
  busy,
}: {
  round: QualificationRound;
  isNext: boolean;
  selectionMode: CompetitionSetupSnapshot["nextRoundSelectionMode"];
  onSelect: (roundId: number) => void;
  busy: boolean;
}) {
  return (
    <article className={isNext ? "round-card next-round" : "round-card"}>
      <div className="round-card-header">
        <strong>جولة {round.order}</strong>
        {isNext ? (
          <span className="badge">
            {selectionMode === "MANUAL" ? "مختارة يدويًا" : "القادمة"}
          </span>
        ) : null}
      </div>

      <div className="versus">
        <span>{round.collegeA.name}</span>
        <b>{round.collegeB ? "VS" : "SOLO"}</b>
        <span>{round.collegeB?.name ?? "جولة فردية"}</span>
      </div>

      <button
        className="small-button"
        disabled={busy || round.status !== "PENDING" || isNext}
        onClick={() => onSelect(round.id)}
      >
        اختيار هذه الجولة كالقادمة
      </button>
    </article>
  );
}

function DrawSurface({
  snapshot,
}: {
  snapshot: CompetitionSetupSnapshot;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (
    action: () => Promise<unknown>,
    successMessage: string,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await action();
      setMessage(successMessage);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "حدث خطأ غير متوقع",
      );
    } finally {
      setBusy(false);
    }
  };

  const createDraw = () => {
    if (
      !window.confirm(
        "إنشاء القرعة الرسمية الآن؟ ستُحفظ الجولات ولن يعاد السحب إلا بإجراء Reset صريح.",
      )
    ) {
      return;
    }

    void run(
      () =>
        apiRequest("/api/draw", {
          method: "POST",
          body: "{}",
        }),
      "تم إنشاء القرعة الرسمية.",
    );
  };

  const resetDraw = () => {
    if (
      !window.confirm(
        "تأكيد Reset للقرعة؟ ترتيب الجولات الحالي سيُحذف، لكن قائمة المشاركين ستبقى مثبتة.",
      )
    ) {
      return;
    }

    void run(
      () =>
        apiRequest("/api/draw/reset", {
          method: "POST",
          body: JSON.stringify({ confirm: "RESET_DRAW" }),
        }),
      "تمت إعادة ضبط القرعة.",
    );
  };

  const selectNextRound = (roundId: number) => {
    void run(
      () =>
        apiRequest("/api/draw/next-round", {
          method: "POST",
          body: JSON.stringify({ roundId }),
        }),
      "تم اختيار الجولة القادمة يدويًا بدون تغيير ترتيب القرعة.",
    );
  };

  const restoreDrawOrder = () => {
    void run(
      () =>
        apiRequest("/api/draw/next-round", {
          method: "POST",
          body: JSON.stringify({ roundId: null }),
        }),
      "رجع اختيار الجولة القادمة حسب ترتيب القرعة.",
    );
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="step-label">الخطوة 4</p>
          <h2>القرعة الرسمية</h2>
        </div>
        <span className="counter">
          {snapshot.participantCollegeIds.length} مشارك
        </span>
      </div>

      {!snapshot.participantsLocked ? (
        <div className="empty-state">
          يجب اختيار الكليات المشاركة وتثبيتها من صفحة الإعداد أولاً.
        </div>
      ) : snapshot.rounds.length === 0 ? (
        <div className="draw-ready">
          <p>
            المشاركون مثبتون. النظام سيخلط الكليات على السيرفر وينشئ
            جولات ثنائية، ومع العدد الفردي ينشئ جولة فردية واحدة فقط.
          </p>
          <button
            className="primary large-button"
            disabled={busy}
            onClick={createDraw}
          >
            إجراء القرعة الرسمية
          </button>
        </div>
      ) : (
        <>
          <div className="draw-summary">
            <span>
              {snapshot.rounds.length} جولات
            </span>
            <span>
              {snapshot.rounds.filter((round) => round.collegeB === null).length}
              {" "}جولة فردية
            </span>
            <span>
              {snapshot.nextRoundSelectionMode === "MANUAL"
                ? "اختيار الجولة القادمة: يدوي"
                : "اختيار الجولة القادمة: حسب القرعة"}
            </span>
          </div>

          <div className="round-grid">
            {snapshot.rounds.map((round) => (
              <RoundCard
                key={round.id}
                round={round}
                isNext={snapshot.nextRoundId === round.id}
                selectionMode={snapshot.nextRoundSelectionMode}
                onSelect={selectNextRound}
                busy={busy}
              />
            ))}
          </div>

          <div className="actions">
            {snapshot.nextRoundSelectionMode === "MANUAL" ? (
              <button disabled={busy} onClick={restoreDrawOrder}>
                الرجوع إلى ترتيب القرعة
              </button>
            ) : null}

            <button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    apiRequest("/api/draw/present", {
                      method: "POST",
                      body: "{}",
                    }),
                  "تم إرسال عرض القرعة إلى شاشة الجمهور.",
                )
              }
            >
              عرض القرعة على شاشة الجمهور
            </button>

            <button
              className="danger-outline"
              disabled={busy}
              onClick={resetDraw}
            >
              Reset القرعة
            </button>
          </div>
        </>
      )}

      <StatusMessage error={error} message={message} />
    </section>
  );
}




function AudienceSceneTransition({
  sceneKey,
  children,
}: {
  sceneKey: string;
  children: ReactNode;
}) {
  return (
    <div
      key={sceneKey}
      className="audience-scene-transition"
    >
      {children}
    </div>
  );
}

function AudienceBroadcastFrame({
  settings,
  children,
}: {
  settings: AudienceDisplaySettings;
  children: ReactNode;
}) {
  const meta = [settings.venue, settings.season]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="audience-frame">
      <header className="audience-brand-header">
        <div className="audience-brand-logo">
          {settings.universityLogoUrl ? (
            <img
              src={settings.universityLogoUrl}
              alt="University logo"
            />
          ) : null}
        </div>
        <div className="audience-brand-copy">
          <strong>{settings.eventTitle}</strong>
          {settings.eventSubtitle ? (
            <span>{settings.eventSubtitle}</span>
          ) : null}
          <div className="audience-patronage">
            <span>{PATRONAGE_LINE}</span>
            <span>{SUPERVISION_LINE}</span>
          </div>
          {meta ? <small>{meta}</small> : null}
        </div>
        <div className="audience-brand-logo">
          {settings.departmentLogoUrl ? (
            <img
              src={settings.departmentLogoUrl}
              alt="Department logo"
            />
          ) : null}
        </div>
      </header>

      <div className="audience-frame-main">{children}</div>

      <footer className="audience-brand-footer">
        {settings.footerText}
      </footer>
    </div>
  );
}

function AudienceDrawSurface({
  snapshot,
  presentation,
  settings,
}: {
  snapshot: CompetitionSetupSnapshot;
  presentation: DrawPresentationEvent | null;
  settings: AudienceDisplaySettings;
}) {
  const participantNames = snapshot.colleges
    .filter((college) => snapshot.participantCollegeIds.includes(college.id))
    .map((college) => college.name);

  if (!snapshot.participantsLocked) {
    return (
      <section className="audience-stage">
        <div className="audience-kicker">{settings.eventTitle}</div>
        <h2 className="audience-title">{settings.copy.welcomeTitle}</h2>
        <p className="audience-copy">{settings.copy.waitingParticipantsText}</p>

        {participantNames.length > 0 ? (
          <>
            <p className="audience-live-participant-count">
              {audienceText(
                settings.copy.participatingCollegeCountText,
                { count: participantNames.length },
              )}
            </p>
            <div className="audience-participants live-selection">
              {participantNames.map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
            <div className="draw-waiting">
              بانتظار تثبيت قائمة الكليات المشاركة
            </div>
          </>
        ) : null}
      </section>
    );
  }

  if (snapshot.rounds.length === 0) {
    return (
      <section className="audience-stage">
        <div className="audience-kicker">{settings.copy.drawPhaseLabel}</div>
        <h2 className="audience-title">{settings.copy.drawOfficialTitle}</h2>
        <p className="audience-copy">
          {audienceText(settings.copy.participatingCollegeCountText, { count: participantNames.length })}
        </p>
        <div className="audience-participants">
          {participantNames.map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <div className="draw-waiting">{settings.copy.drawWaitingText}</div>
      </section>
    );
  }

  const activePresentation = presentation?.rounds.length === snapshot.rounds.length;

  return (
    <section className="audience-stage">
      <div className="audience-kicker">
        {activePresentation
          ? settings.copy.drawPresentingKicker
          : settings.copy.drawResultsKicker}
      </div>
      <h2 className="audience-title">
        {activePresentation
          ? settings.copy.roundsTitle
          : settings.copy.drawOfficialTitle}
      </h2>

      <div
        className={
          activePresentation
            ? "audience-rounds presenting"
            : "audience-rounds"
        }
      >
        {snapshot.rounds.map((round, index) => (
          <article
            className={
              round.collegeB === null
                ? "audience-round solo"
                : "audience-round"
            }
            key={round.id}
            style={
              activePresentation
                ? { animationDelay: `${700 + index * 850}ms` }
                : undefined
            }
          >
            <span className="audience-round-number">
              {settings.roundLabel} {round.order}
            </span>
            <div className="audience-matchup">
              <strong>{round.collegeA.name}</strong>
              <b>{round.collegeB
                ? settings.copy.versusLabel
                : settings.copy.soloLabel}</b>
              <strong>
                {round.collegeB?.name ?? settings.copy.soloRoundText}
              </strong>
            </div>
          </article>
        ))}
      </div>

      <div className="audience-footer-message">
        {activePresentation
          ? settings.copy.drawPresentingFooter
          : settings.copy.drawCompleteFooter}
      </div>
    </section>
  );
}




function AudienceRankingSidebar({
  ranking,
  settings,
}: {
  ranking: QualificationRankingSnapshot | null;
  settings: AudienceDisplaySettings;
}) {
  return (
    <aside className="audience-ranking">
      <div className="audience-ranking-heading">
        <span>{settings.copy.rankingTitle}</span>
        <small>{settings.copy.rankingSubtitle}</small>
      </div>

      <div className="audience-ranking-list">
        {ranking?.entries.map((entry) => (
          <div
            className={[
              "audience-ranking-row",
              "ranking-motion",
              entry.status.toLowerCase().replace("_", "-"),
            ].join(" ")}
            key={entry.college.id}
          >
            <div className="audience-rank-number">
              {entry.rank ?? "—"}
            </div>
            <div className="audience-rank-college">
              <strong>{entry.college.name}</strong>
              <small>
                {entry.status === "PLAYING"
                  ? settings.copy.playingStatus
                  : entry.status === "COMPLETED"
                    ? settings.copy.completedStatus
                    : settings.copy.notStartedStatus}
              </small>
            </div>
            <div className="audience-rank-score">
              {entry.status === "NOT_STARTED"
                ? "—"
                : entry.scorePoints}
              <small>
                {entry.status === "NOT_STARTED"
                  ? ""
                  : ` ${settings.copy.pointsLabel}`}
              </small>
              {entry.status !== "NOT_STARTED" ? (
                <small className="audience-rank-time">
                  الزمن: {(entry.totalResponseTimeMs / 1000).toFixed(3)} ث
                </small>
              ) : null}
            </div>
          </div>
        )) ?? (
          <div className="audience-ranking-empty">
            {settings.copy.waitingRoundsText}
          </div>
        )}
      </div>
    </aside>
  );
}

function AudienceLiveSurface({
  snapshot,
  competition,
  ranking,
  settings,
}: {
  snapshot: LiveSnapshot;
  competition: CompetitionSetupSnapshot;
  ranking: QualificationRankingSnapshot | null;
  settings: AudienceDisplaySettings;
}) {
  const [now, setNow] = useState(Date.now());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);

  useEffect(() => {
    setServerOffsetMs(snapshot.serverNowEpochMs - Date.now());
  }, [snapshot.serverNowEpochMs]);

  useEffect(() => {
    if (
      snapshot.phase !== "QUESTION_COUNTDOWN" &&
      snapshot.phase !== "QUESTION_ACTIVE"
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 100);

    return () => window.clearInterval(timer);
  }, [snapshot.phase]);

  const serverNow = now + serverOffsetMs;
  const countdownValue =
    snapshot.phase === "QUESTION_COUNTDOWN" &&
    snapshot.countdownStartedAtEpochMs !== null
      ? Math.max(
          1,
          Math.ceil(
            (snapshot.countdownStartedAtEpochMs + 3000 - serverNow) /
              1000,
          ),
        )
      : null;

  const remainingSeconds =
    snapshot.phase === "QUESTION_ACTIVE" &&
    snapshot.questionDeadlineEpochMs !== null
      ? Math.max(
          0,
          Math.ceil(
            (snapshot.questionDeadlineEpochMs - serverNow) / 1000,
          ),
        )
      : null;

  const round = snapshot.round;
  const question = snapshot.question;

  const resultCard = (
    label: string,
    collegeName: string,
    result: LiveSnapshot["revealResults"] extends infer R
      ? R extends { teamA: infer T } ? T : never
      : never,
  ) => (
    <div
      className={[
        "audience-team-result",
        result?.isCorrect === true ? "correct" : "",
        result?.answered === false || result?.isCorrect === false
          ? "wrong"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span>{label}</span>
      <strong>{collegeName}</strong>
      {result?.answered ? (
        <>
          <b>
            {settings.copy.answerPrefix}: {result.selectedOption ?? "—"}
          </b>
          <small>
            {result.isCorrect
              ? settings.copy.correctStatus
              : settings.copy.wrongStatus}
            {" · "}
            {result.responseTimeMs !== null
              ? `${(result.responseTimeMs / 1000).toFixed(3)} ${settings.copy.secondsLabel}`
              : "—"}
            {" · "}
            {result.scorePoints} {settings.copy.pointsLabel}
          </small>
        </>
      ) : (
        <>
          <b>{settings.copy.noAnswerText}</b>
          <small>0 {settings.copy.pointsLabel}</small>
        </>
      )}
    </div>
  );

  if (!round) {
    return (
      <section className="audience-stage">
        <div className="audience-kicker">{settings.eventTitle}</div>
        <h2 className="audience-title">{settings.copy.waitingNextRoundText}</h2>
      </section>
    );
  }

  if (snapshot.phase === "QUESTION_COUNTDOWN") {
    return (
      <section className="audience-stage audience-live-stage">
        <div className="audience-round-strip">
          <span>{settings.roundLabel} {round.order}</span>
          <strong>{round.teamA.name}</strong>
          <b>{round.teamB
            ? settings.copy.versusLabel
            : settings.copy.soloLabel}</b>
          <strong>{round.teamB?.name ?? settings.copy.soloRoundText}</strong>
        </div>
        <div className="audience-countdown">{countdownValue}</div>
      </section>
    );
  }

  if (
    snapshot.phase === "QUESTION_READY" ||
    snapshot.phase === "ROUND_READY" ||
    snapshot.phase === "ROUND_ACTIVE" ||
    snapshot.phase === "INTERMISSION"
  ) {
    return (
      <section className="audience-stage audience-live-stage">
        <div className="audience-kicker">
          {settings.roundLabel} {round.order}
        </div>
        <h2 className="audience-title">
          {round.teamA.name}
          <span className="audience-vs">
            {round.teamB
              ? ` ${settings.copy.versusLabel} `
              : " — "}
          </span>
          {round.teamB?.name ?? settings.copy.soloRoundText}
        </h2>
        <p className="audience-copy">
          {snapshot.phase === "QUESTION_READY"
            ? audienceText(settings.copy.questionReadyText, {
                question: question?.position ?? "—",
              })
            : snapshot.phase === "INTERMISSION"
              ? settings.copy.intermissionText
              : settings.copy.roundReadyText}
        </p>
      </section>
    );
  }

  if (
    snapshot.phase === "QUESTION_ACTIVE" ||
    snapshot.phase === "QUESTION_CLOSED" ||
    snapshot.phase === "QUESTION_REVEAL"
  ) {
    const reveal = snapshot.phase === "QUESTION_REVEAL";
    const correctOption = question?.correctOption;

    return (
      <section className="audience-stage audience-live-stage">
        <div className="audience-question-header">
          <div>
            <span>{settings.roundLabel} {round.order}</span>
            <strong>
              {settings.copy.questionLabel} {question?.position ?? "—"} / 10
            </strong>
          </div>
          <span>{question?.categoryName ?? ""}</span>
          <div className="audience-timer">
            {remainingSeconds !== null
              ? remainingSeconds
              : snapshot.phase === "QUESTION_CLOSED"
                ? settings.copy.closedLabel
                : settings.copy.resultLabel}
          </div>
        </div>

        <h2 className="audience-question-text">
          {question?.prompt ?? ""}
        </h2>

        <div className="audience-options">
          {(["A", "B", "C", "D"] as const).map((option) => (
            <div
              className={[
                "audience-option",
                reveal && correctOption === option ? "correct reveal-correct" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={option}
            >
              <b>{option}</b>
              <span>{question?.options?.[option] ?? ""}</span>
            </div>
          ))}
        </div>

        {!reveal ? (
          <div className="audience-answer-status">
            <div
              className={
                snapshot.answerStatus.teamAReceived
                  ? "received"
                  : ""
              }
            >
              <strong>{round.teamA.name}</strong>
              <span>
                {snapshot.answerStatus.teamAReceived
                  ? "تم استلام الإجابة"
                  : "بانتظار الإجابة"}
              </span>
            </div>
            {round.teamB ? (
              <div
                className={
                  snapshot.answerStatus.teamBReceived
                    ? "received"
                    : ""
                }
              >
                <strong>{round.teamB.name}</strong>
                <span>
                  {snapshot.answerStatus.teamBReceived
                    ? "تم استلام الإجابة"
                    : "بانتظار الإجابة"}
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="audience-correct-answer">
              <span>{settings.copy.correctAnswerLabel}</span>
              <strong>
                {correctOption && question?.options
                  ? question.options[correctOption]
                  : "—"}
              </strong>
              <small>
                {correctOption
                  ? `${settings.copy.optionLabel} ${correctOption}`
                  : ""}
              </small>
            </div>

            <div className="audience-results-grid">
              {snapshot.revealResults
                ? resultCard(
                    settings.copy.teamALabel,
                    round.teamA.name,
                    snapshot.revealResults.teamA,
                  )
                : null}
              {snapshot.revealResults?.teamB && round.teamB
                ? resultCard(
                    settings.copy.teamBLabel,
                    round.teamB.name,
                    snapshot.revealResults.teamB,
                  )
                : null}
            </div>
          </>
        )}

        {snapshot.phase === "QUESTION_CLOSED" ? (
          <div className="audience-closed-note">
            {settings.copy.closedWaitingResultText}
          </div>
        ) : null}
      </section>
    );
  }

  if (snapshot.phase === "ROUND_COMPLETE") {
    const totals = snapshot.roundTotals;

    if (snapshot.qualificationComplete && snapshot.resultsAnnounced) {
      const finalists =
        ranking?.entries
          .filter((entry) => entry.rank !== null)
          .slice(0, 3) ?? [];

      return (
        <section className="audience-stage audience-live-stage final-results-stage">
          <div className="audience-kicker">{settings.copy.qualificationCompleteKicker}</div>
          <h2 className="audience-title">
            {settings.copy.finalRankingTitle}
          </h2>

          <div className="audience-final-podium">
            {finalists.map((entry) => (
              <div
                className={[
                  "audience-final-card",
                  entry.rank === 1 ? "leader" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={entry.college.id}
              >
                <span>
                  {audienceText(settings.copy.positionLabel, {
                    rank: entry.rank ?? "—",
                  })}
                </span>
                <strong>{entry.college.name}</strong>
                <b>{entry.scorePoints} {settings.copy.pointsLabel}</b>
                <small>
                  الزمن الإجمالي: {(entry.totalResponseTimeMs / 1000).toFixed(3)} ث
                </small>
              </div>
            ))}
          </div>

          <p className="audience-copy">
            {settings.copy.qualificationFinalText}
          </p>
        </section>
      );
    }

    if (snapshot.qualificationComplete && !snapshot.resultsAnnounced) {
      return (
        <section className="audience-stage audience-live-stage">
          <div className="audience-kicker">
            {settings.copy.qualificationCompleteKicker}
          </div>
          <h2 className="audience-title">انتهت جميع الجولات</h2>
          <p className="audience-copy">
            بانتظار إعلان النتائج النهائية
          </p>
        </section>
      );
    }

    const nextRound =
      competition.rounds.find(
        (candidate) =>
          candidate.id === competition.nextRoundId &&
          candidate.id !== round.id &&
          candidate.status === "PENDING",
      ) ??
      competition.rounds.find(
        (candidate) =>
          candidate.id !== round.id &&
          candidate.status === "PENDING",
      ) ??
      null;

    return (
      <section className="audience-stage audience-live-stage">
        <div className="audience-kicker">
          {settings.copy.roundEndedPrefix} {settings.roundLabel} {round.order}
        </div>
        <h2 className="audience-title">{settings.copy.roundResultTitle}</h2>

        {totals ? (
          <div className="audience-round-totals">
            <div>
              <span>{round.teamA.name}</span>
              <strong>{totals.teamA}</strong>
              <small>{settings.copy.pointsLabel}</small>
            </div>
            {round.teamB && totals.teamB !== null ? (
              <div>
                <span>{round.teamB.name}</span>
                <strong>{totals.teamB}</strong>
                <small>{settings.copy.pointsLabel}</small>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="audience-next-round-block">
          <h3>{settings.copy.nextRoundTitle}</h3>

        {nextRound ? (
          <div className="audience-next-match">
            <span>{settings.roundLabel} {nextRound.order}</span>
            <strong>{nextRound.collegeA.name}</strong>
            <b>{nextRound.collegeB
              ? settings.copy.versusLabel
              : settings.copy.soloLabel}</b>
            <strong>
              {nextRound.collegeB?.name ?? settings.copy.soloRoundText}
            </strong>
          </div>
        ) : (
          <p className="audience-copy">
            {settings.copy.waitingNextRoundSelectionText}
          </p>
        )}
        </div>
      </section>
    );
  }

  return (
    <section className="audience-stage">
      <h2 className="audience-title">
        {settings.copy.waitingNextRoundText}
      </h2>
    </section>
  );
}

function phaseLabel(phase: LiveSnapshot["phase"]): string {
  const labels: Record<LiveSnapshot["phase"], string> = {
    IDLE: "بانتظار تجهيز الجولة",
    ROUND_READY: "الجولة جاهزة",
    ROUND_ACTIVE: "الجولة فعالة",
    QUESTION_READY: "السؤال جاهز",
    QUESTION_COUNTDOWN: "العد التنازلي",
    QUESTION_ACTIVE: "السؤال فعال",
    QUESTION_CLOSED: "تم إغلاق السؤال",
    QUESTION_REVEAL: "إظهار النتيجة",
    INTERMISSION: "استراحة",
    ROUND_COMPLETE: "انتهت الجولة",
  };

  return labels[phase];
}


interface StationCredentialResponse {
  teamA: { station: "A"; token: string } | null;
  teamB: { station: "B"; token: string } | null;
}



function AudienceAnnouncementSurface({
  presentation,
}: {
  presentation: AudiencePresentationSnapshot;
}) {
  return (
    <section className="audience-stage audience-announcement">
      <div className="audience-kicker">UniQuiz</div>
      <h2 className="audience-title">
        {presentation.title}
      </h2>
      {presentation.message ? (
        <p className="audience-copy">
          {presentation.message}
        </p>
      ) : null}
    </section>
  );
}

const PRESHOW_PRESENTATION_MARKER = "__UNIQUIZ_PRESHOW__";

type AudiencePreShowPage = "identity" | "about" | "mechanism";

function PreShowTopBar({
  settings,
}: {
  settings: AudienceDisplaySettings;
}) {
  return (
    <header className="preshow-v2-topbar">
      <div className="preshow-v2-topbar-logo">
        {settings.universityLogoUrl ? (
          <img
            src={settings.universityLogoUrl}
            alt="شعار جامعة بابل"
          />
        ) : null}
      </div>

      <div className="preshow-v2-topbar-copy">
        {settings.eventSubtitle ? (
          <span>{settings.eventSubtitle}</span>
        ) : null}
        <strong>{settings.eventTitle}</strong>
      </div>

      <div className="preshow-v2-topbar-logo">
        {settings.departmentLogoUrl ? (
          <img
            src={settings.departmentLogoUrl}
            alt="شعار قسم النشاطات الطلابية"
          />
        ) : null}
      </div>
    </header>
  );
}

function AudiencePreShowSurface({
  settings,
  categories,
  presentationKey,
}: {
  settings: AudienceDisplaySettings;
  categories: QuestionBankSummary["categories"];
  presentationKey: string;
}) {
  const enabledPages = (
    [
      settings.copy.preShow.identityEnabled ? "identity" : null,
      settings.copy.preShow.aboutEnabled ? "about" : null,
      settings.copy.preShow.mechanismEnabled ? "mechanism" : null,
    ] as Array<AudiencePreShowPage | null>
  ).filter(
    (page): page is AudiencePreShowPage => page !== null,
  );

  const enabledKey = enabledPages.join(":");
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    setPageIndex(0);
  }, [presentationKey, enabledKey]);

  useEffect(() => {
    if (enabledPages.length <= 1) return;

    const timer = window.setInterval(() => {
      setPageIndex((current) =>
        (current + 1) % enabledPages.length,
      );
    }, settings.copy.preShow.intervalSeconds * 1000);

    return () => window.clearInterval(timer);
  }, [
    presentationKey,
    enabledKey,
    enabledPages.length,
    settings.copy.preShow.intervalSeconds,
  ]);

  const currentPage =
    enabledPages[
      pageIndex % Math.max(enabledPages.length, 1)
    ] ?? "identity";

  const visibleIndex = enabledPages.indexOf(currentPage) + 1;

  return (
    <section className="audience-stage audience-preshow preshow-v2">
      <div
        key={currentPage}
        className={`preshow-v2-page preshow-v2-${currentPage}`}
      >
        {currentPage === "identity" ? (
          <>
            <div className="preshow-v2-hero-logos">
              <div>
                {settings.universityLogoUrl ? (
                  <img
                    src={settings.universityLogoUrl}
                    alt="شعار جامعة بابل"
                  />
                ) : null}
              </div>
              <div>
                {settings.departmentLogoUrl ? (
                  <img
                    src={settings.departmentLogoUrl}
                    alt="شعار قسم النشاطات الطلابية"
                  />
                ) : null}
              </div>
            </div>

            <div className="preshow-v2-hero">
              {settings.eventSubtitle ? (
                <div className="preshow-v2-eyebrow">
                  {settings.eventSubtitle}
                </div>
              ) : null}

              <h1>{settings.eventTitle}</h1>
              <div className="preshow-v2-title-rule" />

              {settings.copy.preShow.identityLine.trim() ? (
                <p className="preshow-v2-identity-line">
                  {settings.copy.preShow.identityLine}
                </p>
              ) : null}
            </div>

            <div className="preshow-v2-patronage-grid">
              <article>
                <span>الرعاية</span>
                <strong>{PATRONAGE_LINE}</strong>
              </article>
              <article>
                <span>الإشراف</span>
                <strong>{SUPERVISION_LINE}</strong>
              </article>
            </div>
          </>
        ) : null}

        {currentPage === "about" ? (
          <>
            <PreShowTopBar settings={settings} />

            <main className="preshow-v2-about-main">
              <section className="preshow-v2-about-copy">
                <div className="preshow-v2-section-kicker">
                  <span>01</span>
                  <b>عن المسابقة</b>
                </div>

                <h2>معرفة، سرعة قرار، ومنافسة جامعية واحدة</h2>

                <p className="preshow-v2-lead">
                  منافسة ثقافية تجمع طلبة كليات جامعة بابل في أجواء
                  من المعرفة والتحدي والتفاعل، وتهدف إلى تعزيز
                  الثقافة العامة وسرعة التفكير وروح المنافسة
                  الإيجابية بين الطلبة.
                </p>

                <div className="preshow-v2-callout">
                  <strong>كيف تجري المنافسة؟</strong>
                  <span>
                    يجيب الفريقان عن السؤال نفسه في الوقت نفسه،
                    وتُحتسب النتيجة إلكترونياً وفق صحة الإجابة
                    وسرعة الاستجابة.
                  </span>
                </div>
              </section>

              <section className="preshow-v2-category-panel">
                <div className="preshow-v2-category-heading">
                  <span>5</span>
                  <div>
                    <small>محاور المعرفة</small>
                    <strong>تنوع يصنع المنافسة</strong>
                  </div>
                </div>

                <div className="preshow-v2-category-grid">
                  {categories.length > 0 ? (
                    categories.map((category, index) => (
                      <article key={category.key}>
                        <span>
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <strong>{category.name}</strong>
                      </article>
                    ))
                  ) : (
                    <article className="empty">
                      <strong>بانتظار تحميل المحاور</strong>
                    </article>
                  )}
                </div>
              </section>
            </main>
          </>
        ) : null}

        {currentPage === "mechanism" ? (
          <>
            <PreShowTopBar settings={settings} />

            <main className="preshow-v2-mechanism-main">
              <div className="preshow-v2-mechanism-heading">
                <div className="preshow-v2-section-kicker">
                  <span>02</span>
                  <b>آلية المسابقة</b>
                </div>
                <h2>كل ثانية تصنع فرقاً</h2>
              </div>

              <div className="preshow-v2-stat-grid">
                <article>
                  <strong>10</strong>
                  <span>أسئلة</span>
                  <small>في كل جولة</small>
                </article>
                <article>
                  <strong>5</strong>
                  <span>محاور</span>
                  <small>سؤالان لكل محور</small>
                </article>
                <article>
                  <strong>25</strong>
                  <span>ثانية</span>
                  <small>زمن الإجابة</small>
                </article>
                <article>
                  <strong>25 ← 1</strong>
                  <span>نقطة</span>
                  <small>للإجابة الصحيحة حسب السرعة</small>
                </article>
              </div>

              <div className="preshow-v2-rule-grid">
                <article>
                  <span>01</span>
                  <p>
                    الفريقان يجيبان عن السؤال نفسه في الوقت نفسه،
                    وتُثبت الإجابة فور إرسالها.
                  </p>
                </article>
                <article>
                  <span>02</span>
                  <p>
                    الإجابة الخاطئة أو عدم الإجابة تحتسب
                    <b> 0 نقطة</b>.
                  </p>
                </article>
                <article>
                  <span>03</span>
                  <p>
                    عند تساوي النقاط يتقدم الفريق صاحب
                    <b> الزمن التراكمي الأقل</b>.
                  </p>
                </article>
                <article>
                  <span>04</span>
                  <p>
                    بعد اكتمال جميع الجولات تعتمد المراكز الثلاثة
                    الأولى وفق الترتيب النهائي.
                  </p>
                </article>
              </div>
            </main>
          </>
        ) : null}

        <div className="preshow-v2-nav" aria-label="صفحات العرض التمهيدي">
          <span className="preshow-v2-nav-count">
            {visibleIndex} / {Math.max(enabledPages.length, 1)}
          </span>
          <div className="preshow-v2-nav-dots">
            {enabledPages.map((page, index) => (
              <span
                key={page}
                className={
                  index ===
                  pageIndex % Math.max(enabledPages.length, 1)
                    ? "active"
                    : ""
                }
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PresentationControlPanel({
  settings,
}: {
  settings: AudienceDisplaySettings | null;
}) {
  const [customTitle, setCustomTitle] = useState("");
  const [customMessage, setCustomMessage] = useState("");
  const [preShowDraft, setPreShowDraft] = useState<
    AudienceDisplaySettings["copy"]["preShow"] | null
  >(settings?.copy.preShow ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setPreShowDraft(settings?.copy.preShow ?? null);
  }, [settings]);

  const show = async (
    kind:
      | "BREAK"
      | "PLEASE_WAIT"
      | "NEXT_ROUND"
      | "PREPARE_TEAMS"
      | "FINAL_RESULTS_SOON"
      | "CUSTOM",
    title?: string,
    text?: string,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest("/api/presentation/show", {
        method: "POST",
        body: JSON.stringify({
          kind,
          title,
          message: text,
        }),
      });
      setMessage("تم عرض المشهد على شاشة الجمهور.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر عرض المشهد",
      );
    } finally {
      setBusy(false);
    }
  };

  const savePreShowSettings = async () => {
    if (!settings || !preShowDraft) {
      throw new Error("إعدادات شاشة الجمهور غير جاهزة.");
    }

    await apiRequest<AudienceDisplaySettings>(
      "/api/audience/settings",
      {
        method: "PUT",
        body: JSON.stringify({
          eventTitle: settings.eventTitle,
          eventSubtitle: settings.eventSubtitle,
          venue: settings.venue,
          season: settings.season,
          footerText: settings.footerText,
          roundLabel: settings.roundLabel,
          copy: {
            ...settings.copy,
            preShow: preShowDraft,
          },
        }),
      },
    );
  };

  const savePreShow = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await savePreShowSettings();
      setMessage("تم حفظ إعدادات صفحات ما قبل المسابقة.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر حفظ إعدادات العرض التمهيدي",
      );
    } finally {
      setBusy(false);
    }
  };

  const startPreShow = async () => {
    if (!preShowDraft) return;

    const anyEnabled =
      preShowDraft.identityEnabled ||
      preShowDraft.aboutEnabled ||
      preShowDraft.mechanismEnabled;

    if (!anyEnabled) {
      setError("فعّل شاشة واحدة على الأقل قبل تشغيل العرض التمهيدي.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await savePreShowSettings();
      await apiRequest("/api/presentation/show", {
        method: "POST",
        body: JSON.stringify({
          kind: "CUSTOM",
          title: PRESHOW_PRESENTATION_MARKER,
        }),
      });
      setMessage("بدأ العرض التمهيدي وسيتم التبديل بين الشاشات تلقائياً.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر تشغيل العرض التمهيدي",
      );
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiRequest("/api/presentation/clear", {
        method: "POST",
        body: "{}",
      });
      setMessage("تم إيقاف المشهد والرجوع إلى شاشة المسابقة.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر إغلاق المشهد",
      );
    } finally {
      setBusy(false);
    }
  };

  const updatePreShow = (
    patch: Partial<AudienceDisplaySettings["copy"]["preShow"]>,
  ) => {
    setPreShowDraft((current) =>
      current ? { ...current, ...patch } : current,
    );
  };

  return (
    <section className="panel presentation-control-panel">
      <div className="section-heading">
        <div>
          <p className="step-label">Audience Presentation</p>
          <h2>مشاهد شاشة الجمهور</h2>
        </div>
      </div>

      <div className="preshow-control">
        <label className="preshow-identity-line-control">
          <span>سطر إضافي في شاشة الهوية</span>
          <input
            value={preShowDraft?.identityLine ?? ""}
            disabled={busy || !preShowDraft}
            placeholder="مثال: أهلاً بكم في المنافسة الثقافية بين كليات جامعة بابل"
            onChange={(event) =>
              updatePreShow({
                identityLine: event.target.value,
              })
            }
          />
          <small>
            اختياري — يظهر أسفل عنوان المسابقة في الشاشة الأولى.
          </small>
        </label>

        <div className="preshow-control-heading">
          <div>
            <strong>العرض التمهيدي — 3 شاشات</strong>
            <span>
              تتبدل تلقائياً وتبقى في Loop إلى أن تبدأ المسابقة.
            </span>
          </div>
          <label>
            <span>مدة كل شاشة</span>
            <input
              type="number"
              min={5}
              max={30}
              value={preShowDraft?.intervalSeconds ?? 10}
              disabled={busy || !preShowDraft}
              onChange={(event) =>
                updatePreShow({
                  intervalSeconds: Math.min(
                    30,
                    Math.max(5, Number(event.target.value) || 10),
                  ),
                })
              }
            />
            <small>ثانية</small>
          </label>
        </div>

        <div className="preshow-toggle-grid">
          <label>
            <input
              type="checkbox"
              checked={preShowDraft?.identityEnabled ?? false}
              disabled={busy || !preShowDraft}
              onChange={(event) =>
                updatePreShow({
                  identityEnabled: event.target.checked,
                })
              }
            />
            <span>
              <strong>1. الهوية والرعاية</strong>
              <small>افتتاحية قوية + الرعاية والإشراف</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preShowDraft?.aboutEnabled ?? false}
              disabled={busy || !preShowDraft}
              onChange={(event) =>
                updatePreShow({
                  aboutEnabled: event.target.checked,
                })
              }
            />
            <span>
              <strong>2. نبذة ومحاور</strong>
              <small>تعريف مختصر + المحاور الخمسة</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preShowDraft?.mechanismEnabled ?? false}
              disabled={busy || !preShowDraft}
              onChange={(event) =>
                updatePreShow({
                  mechanismEnabled: event.target.checked,
                })
              }
            />
            <span>
              <strong>3. آلية المسابقة</strong>
              <small>الأرقام الأساسية + قواعد المنافسة</small>
            </span>
          </label>
        </div>

        <div className="actions">
          <button
            disabled={busy || !preShowDraft}
            onClick={() => void savePreShow()}
          >
            حفظ إعدادات الشاشات
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !preShowDraft ||
              !(
                preShowDraft.identityEnabled ||
                preShowDraft.aboutEnabled ||
                preShowDraft.mechanismEnabled
              )
            }
            onClick={() => void startPreShow()}
          >
            تشغيل العرض التمهيدي
          </button>
          <button
            className="danger-outline"
            disabled={busy}
            onClick={() => void clear()}
          >
            بدء المسابقة — إيقاف العرض
          </button>
        </div>
      </div>

      <div className="presentation-presets">
        <button disabled={busy} onClick={() => void show("BREAK")}>
          استراحة قصيرة
        </button>
        <button disabled={busy} onClick={() => void show("PLEASE_WAIT")}>
          يرجى الانتظار
        </button>
        <button disabled={busy} onClick={() => void show("PREPARE_TEAMS")}>
          استعداد الفرق
        </button>
        <button disabled={busy} onClick={() => void show("NEXT_ROUND")}>
          الجولة القادمة
        </button>
        <button disabled={busy} onClick={() => void show("FINAL_RESULTS_SOON")}>
          النتائج قريبًا
        </button>
      </div>

      <div className="presentation-custom">
        <input
          value={customTitle}
          placeholder="عنوان رسالة مخصصة"
          onChange={(event) => setCustomTitle(event.target.value)}
        />
        <input
          value={customMessage}
          placeholder="نص الرسالة"
          onChange={(event) => setCustomMessage(event.target.value)}
        />
        <button
          disabled={busy || customTitle.trim().length === 0}
          onClick={() =>
            void show(
              "CUSTOM",
              customTitle.trim(),
              customMessage.trim(),
            )
          }
        >
          عرض الرسالة المخصصة
        </button>
      </div>

      <div className="actions">
        <button
          className="danger-outline"
          disabled={busy}
          onClick={() => void clear()}
        >
          إغلاق المشهد والرجوع للبث الحي
        </button>
      </div>

      <StatusMessage error={error} message={message} />
    </section>
  );
}

function OperationsPreflightPanel() {
  const [snapshot, setSnapshot] =
    useState<OperationsPreflightSnapshot | null>(null);
  const [diagnostics, setDiagnostics] =
    useState<OperationsDiagnosticsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [next, diagnosticSnapshot] =
        await Promise.all([
          apiRequest<OperationsPreflightSnapshot>(
            "/api/operations/preflight",
          ),
          apiRequest<OperationsDiagnosticsSnapshot>(
            "/api/operations/diagnostics",
          ),
        ]);
      setSnapshot(next);
      setDiagnostics(diagnosticSnapshot);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر قراءة Preflight",
      );
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const createBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/operations/backup", {
        method: "POST",
        body: "{}",
      });
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر إنشاء النسخة الاحتياطية",
      );
    } finally {
      setBusy(false);
    }
  };

  const sendOscTest = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/operations/osc-test/send", {
        method: "POST",
        body: "{}",
      });
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر إرسال OSC Test",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmOscTest = async () => {
    if (
      !window.confirm(
        "أكد فقط إذا شاهدت أو استلمت /uniquiz/system/test على نظام OSC.",
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/operations/osc-test/confirm", {
        method: "POST",
        body: JSON.stringify({
          confirm: "OSC_TEST_RECEIVED",
        }),
      });
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر تأكيد OSC Test",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel preflight-panel">
      <div className="section-heading">
        <div>
          <p className="step-label">Event-Day Preflight</p>
          <h2>جاهزية النظام</h2>
        </div>
        <span
          className={[
            "preflight-summary",
            snapshot?.ready ? "ready" : "not-ready",
          ].join(" ")}
        >
          {snapshot?.ready ? "READY" : "NOT READY"}
        </span>
      </div>

      <div className="preflight-grid">
        {snapshot?.checks.map((check) => (
          <div
            className={[
              "preflight-check",
              check.ready ? "ready" : "not-ready",
              check.required ? "required" : "optional",
            ].join(" ")}
            key={check.key}
          >
            <div>
              <strong>{check.label}</strong>
              <span>
                {check.required ? "مطلوب" : "اختياري"}
              </span>
            </div>
            <b>{check.ready ? "READY" : "NOT READY"}</b>
            <small>{check.detail}</small>
          </div>
        )) ?? <p>بانتظار فحص الجاهزية...</p>}
      </div>

      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void createBackup()}
        >
          إنشاء Backup موثّق الآن
        </button>
        <button
          disabled={busy}
          onClick={() => void refresh()}
        >
          إعادة فحص الجاهزية
        </button>
        <button
          disabled={busy}
          onClick={() => void sendOscTest()}
        >
          إرسال OSC Test
        </button>
        <button
          disabled={busy}
          onClick={() => void confirmOscTest()}
        >
          تأكيد استلام OSC Test
        </button>
        <a
          className="button-link"
          href="/api/export/results.xlsx"
          download
        >
          تصدير النتائج + Audit
        </a>
      </div>

      {snapshot?.latestBackup ? (
        <p className="muted">
          آخر Backup: {snapshot.latestBackup.fileName} ·{" "}
          {Math.round(
            snapshot.latestBackup.sizeBytes / 1024,
          )} KB
        </p>
      ) : null}


      {diagnostics ? (
        <details className="network-diagnostics">
          <summary>LAN / Network Diagnostics</summary>
          <div className="network-diagnostics-meta">
            <span>Host: {diagnostics.hostname}</span>
            <span>Mode: {diagnostics.mode.toUpperCase()}</span>
            <span>Node: {diagnostics.nodeVersion}</span>
            <span>DB: {diagnostics.databaseFileName}</span>
            <span>
              OSC:{" "}
              {diagnostics.osc.enabled
                ? `${diagnostics.osc.host}:${diagnostics.osc.port}`
                : "Disabled"}
            </span>
          </div>

          <div className="network-url-list">
            {diagnostics.interfaces.length > 0 ? (
              diagnostics.interfaces.map((entry) => (
                <div key={`${entry.name}:${entry.address}`}>
                  <strong>
                    {entry.name} · {entry.address}
                  </strong>
                  <code>{entry.webBaseUrl}/operator</code>
                  <code>{entry.webBaseUrl}/display</code>
                  <code>{entry.serverHealthUrl}</code>
                </div>
              ))
            ) : (
              <p className="muted">
                لا توجد واجهة IPv4 LAN غير داخلية حاليًا.
              </p>
            )}
          </div>
        </details>
      ) : null}

      <StatusMessage error={error} message={null} />
    </section>
  );
}

function StationAccessPanel() {
  const [credentials, setCredentials] =
    useState<StationCredentialResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiRequest<StationCredentialResponse>(
      "/api/stations/credentials",
    )
      .then(setCredentials)
      .catch((caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "تعذر تحميل روابط المحطات",
        );
      });
  }, []);

  const urlFor = (station: "a" | "b", token: string) =>
    `${window.location.origin}/team/${station}?token=${encodeURIComponent(token)}`;

  return (
    <section className="panel station-access-panel">
      <div className="section-heading">
        <div>
          <p className="step-label">Station Access</p>
          <h2>روابط محطات المتسابقين</h2>
        </div>
      </div>

      <p className="muted">
        افتح كل رابط على جهاز الفريق المقابل. التوكن يثبت هوية المحطة
        ويُحفظ في المتصفح بعد أول فتح.
      </p>

      {credentials ? (
        <div className="station-links">
          {credentials.teamA ? (
            <div>
              <strong>Team A</strong>
              <code>
                {urlFor("a", credentials.teamA.token)}
              </code>
            </div>
          ) : null}
          {credentials.teamB ? (
            <div>
              <strong>Team B</strong>
              <code>
                {urlFor("b", credentials.teamB.token)}
              </code>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="muted station-link-note">
        إذا لوحة التحكم مفتوحة على localhost، استبدل localhost بعنوان
        IP الماك على شبكة المسابقة قبل فتح الرابط على أجهزة Windows.
      </p>

      <StatusMessage error={error} message={null} />
    </section>
  );
}

function StationPortal() {
  const [credentials, setCredentials] =
    useState<StationCredentialResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiRequest<StationCredentialResponse>(
      "/api/stations/credentials",
    )
      .then(setCredentials)
      .catch((caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "تعذر تحميل بيانات المحطات",
        );
      });
  }, []);

  const stationUrl = (
    station: "a" | "b",
    token: string,
  ) =>
    `/team/${station}?token=${encodeURIComponent(token)}`;

  return (
    <section className="panel station-portal">
      <div className="station-portal-heading">
        <p className="step-label">Quick Station Access</p>
        <h2>اختيار محطة المسابقة</h2>
        <p className="muted">
          افتح هذا العنوان على الحاسبات الأخرى ثم اختر المحطة المطلوبة.
        </p>
      </div>

      {credentials ? (
        <div className="station-portal-grid">
          {credentials.teamA ? (
            <a
              className="station-portal-card"
              href={stationUrl("a", credentials.teamA.token)}
            >
              <span>Station A</span>
              <strong>محطة الفريق A</strong>
              <small>دخول مباشر وآمن بالتوكن</small>
            </a>
          ) : null}

          {credentials.teamB ? (
            <a
              className="station-portal-card"
              href={stationUrl("b", credentials.teamB.token)}
            >
              <span>Station B</span>
              <strong>محطة الفريق B</strong>
              <small>دخول مباشر وآمن بالتوكن</small>
            </a>
          ) : null}

          <a
            className="station-portal-card secondary"
            href="/display"
          >
            <span>Display</span>
            <strong>شاشة الجمهور</strong>
            <small>فتح العرض العام بملء الشاشة</small>
          </a>
        </div>
      ) : (
        <p className="muted">جاري تجهيز روابط المحطات...</p>
      )}

      <StatusMessage error={error} message={null} />
    </section>
  );
}


function OperatorHotkeys({
  snapshot,
  busy,
  run,
  emergencyHold,
  voidAndReplace,
}: {
  snapshot: LiveSnapshot;
  busy: boolean;
  run: (path: string, successMessage: string) => Promise<void>;
  emergencyHold: () => Promise<void>;
  voidAndReplace: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const confirmAndRun = async (
    message: string,
    path: string,
    successMessage: string,
  ) => {
    if (!window.confirm(message)) {
      return;
    }
    await run(path, successMessage);
  };

  useEffect(() => {
    if (!enabled || busy) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable
        )
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (key === "n") {
        if (
          snapshot.phase === "IDLE" ||
          (snapshot.phase === "ROUND_COMPLETE" &&
            snapshot.hasPendingRound)
        ) {
          consume();
          setLastAction("Alt+N · تجهيز الجولة القادمة");
          void run(
            "/api/live/prepare-round",
            "تم تجهيز الجولة القادمة.",
          );
          return;
        }

        if (
          snapshot.phase === "ROUND_READY" &&
          !snapshot.stationsConfirmed
        ) {
          consume();
          setLastAction("Alt+N · تأكيد المحطات");
          void run(
            "/api/live/confirm-stations",
            "تم تأكيد توزيع المحطات.",
          );
          return;
        }

        if (
          snapshot.phase === "ROUND_ACTIVE" ||
          snapshot.phase === "INTERMISSION" ||
          (
            snapshot.phase === "QUESTION_REVEAL" &&
            (snapshot.question?.position ?? 0) < 10
          )
        ) {
          consume();
          setLastAction("Alt+N · تجهيز السؤال التالي");
          void run(
            "/api/live/start-next-question",
            "بدأ السؤال التالي مباشرةً بالعد التنازلي 3-2-1.",
          );
        }
        return;
      }

      if (key === "s") {
        if (
          snapshot.phase === "ROUND_READY" &&
          snapshot.stationsConfirmed
        ) {
          consume();
          setLastAction("Alt+S · بدء الجولة");
          void confirmAndRun(
            "بدء الجولة الآن؟",
            "/api/live/start-round",
            "بدأت الجولة.",
          );
          return;
        }

        if (snapshot.phase === "QUESTION_READY") {
          consume();
          setLastAction("Alt+S · START السؤال");
          void confirmAndRun(
            "بدء العد 3-2-1 وإظهار السؤال للمتسابقين؟",
            "/api/live/start-question",
            "بدأ العد التنازلي 3-2-1.",
          );
        }
        return;
      }

      if (
        key === "r" &&
        snapshot.phase === "QUESTION_CLOSED" &&
        snapshot.closeReason !== "ALL_TEAMS_ANSWERED" &&
        snapshot.closeReason !== "SOLO_ANSWERED" &&
        snapshot.closeReason !== "TIMEOUT" &&
        snapshot.closeReason !== "SERVER_RESTART_RECOVERY" &&
        snapshot.closeReason !== "EMERGENCY_HOLD"
      ) {
        consume();
        setLastAction("Alt+R · Reveal");
        void confirmAndRun(
          "إعلان نتيجة السؤال الآن؟",
          "/api/live/reveal",
          "تم إظهار الإجابة.",
        );
        return;
      }

      if (
        key === "h" &&
        (
          snapshot.phase === "QUESTION_COUNTDOWN" ||
          snapshot.phase === "QUESTION_ACTIVE"
        )
      ) {
        consume();
        setLastAction("Alt+H · Emergency Hold");
        void emergencyHold();
        return;
      }

      if (
        key === "v" &&
        snapshot.question?.position != null &&
        [
          "QUESTION_READY",
          "QUESTION_CLOSED",
          "QUESTION_REVEAL",
          "INTERMISSION",
        ].includes(snapshot.phase)
      ) {
        consume();
        setLastAction("Alt+V · VOID + replacement");
        void voidAndReplace();
        return;
      }

      if (
        key === "c" &&
        snapshot.phase === "QUESTION_REVEAL" &&
        snapshot.question?.position === 10
      ) {
        consume();
        setLastAction("Alt+C · إنهاء الجولة");
        void confirmAndRun(
          "إنهاء الجولة واعتماد مجموعها الآن؟",
          "/api/live/complete-round",
          "تم إنهاء الجولة.",
        );
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    enabled,
    busy,
    snapshot,
    run,
    emergencyHold,
    voidAndReplace,
  ]);

  return (
    <div className="operator-hotkeys">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setLastAction(null);
          }}
        />
        تفعيل اختصارات الأوبريتر لهذه الجلسة فقط
      </label>

      {enabled ? (
        <>
          <div className="hotkey-legend">
            <kbd>Alt+N</kbd><span>التالي / تجهيز</span>
            <kbd>Alt+S</kbd><span>START</span>
            <kbd>Alt+R</kbd><span>Reveal</span>
            <kbd>Alt+H</kbd><span>Emergency Hold</span>
            <kbd>Alt+V</kbd><span>VOID + replacement</span>
            <kbd>Alt+C</kbd><span>إنهاء الجولة</span>
          </div>
          <small>
            START وReveal وإنهاء الجولة تبقى بتأكيد. Emergency Hold وVOID
            يبقيان بسبب إلزامي + تأكيد. الاختصارات لا تعمل أثناء الكتابة
            داخل الحقول.
          </small>
          {lastAction ? (
            <small className="hotkey-last-action">
              آخر اختصار: {lastAction}
            </small>
          ) : null}
        </>
      ) : null}
    </div>
  );
}


function OperatorLivePanel({
  snapshot,
}: {
  snapshot: LiveSnapshot | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!snapshot) {
    return (
      <section className="panel">
        <h2>التشغيل الحي</h2>
        <p>بانتظار حالة الجولة...</p>
      </section>
    );
  }

  const run = async (
    path: string,
    successMessage: string,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest(path, {
        method: "POST",
        body: "{}",
      });
      setMessage(successMessage);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر تنفيذ الأمر",
      );
    } finally {
      setBusy(false);
    }
  };

  const questionPosition = snapshot.question?.position ?? null;

  const runReasonAction = async (
    path: string,
    promptText: string,
    confirmText: string,
    successMessage: string,
  ) => {
    const reason = window.prompt(promptText, "");
    if (!reason || reason.trim().length < 3) {
      setError("يجب كتابة سبب واضح.");
      setMessage(null);
      return;
    }

    if (!window.confirm(confirmText)) {
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify({
          reason: reason.trim(),
        }),
      });
      setMessage(successMessage);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر تنفيذ الإجراء",
      );
    } finally {
      setBusy(false);
    }
  };

  const overrideStations = async () =>
    runReasonAction(
      "/api/live/override-stations",
      "اكتب سبب تجاوز Station Ready Check:",
      "هذا Override طارئ وسيتم تسجيله في Audit. هل تريد المتابعة؟",
      "تم اعتماد Station Ready Override وتسجيل السبب.",
    );

  const emergencyHold = async () =>
    runReasonAction(
      "/api/live/emergency-hold",
      "اكتب سبب Emergency Hold:",
      "سيتم إيقاف التسلسل الحالي بشكل صريح وتسجيل السبب. إذا كان السؤال فعالاً سيحتاج VOID + replacement. متابعة؟",
      "تم تنفيذ Emergency Hold وتسجيل السبب.",
    );

  const voidAndReplace = async () => {
    if (!snapshot.round || questionPosition === null) {
      return;
    }

    const reason = window.prompt(
      "سبب إلغاء السؤال واستبداله بنفس المحور:",
      snapshot.closeReason === "SERVER_RESTART_RECOVERY"
        ? "Server restart during active question"
        : "",
    );

    if (!reason || reason.trim().length < 3) {
      setError("يجب كتابة سبب واضح للإلغاء والاستبدال.");
      setMessage(null);
      return;
    }

    if (
      !window.confirm(
        "سيتم VOID للسؤال الحالي وحذف إجاباته التشغيلية من النتيجة، مع الاحتفاظ بالتاريخ في Audit، ثم اختيار سؤال بديل من نفس المحور. متابعة؟",
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest("/api/question-bank/void-replace", {
        method: "POST",
        body: JSON.stringify({
          roundId: snapshot.round.id,
          position: questionPosition,
          reason: reason.trim(),
          confirm: "VOID_AND_REPLACE",
        }),
      });
      setMessage(
        "تم VOID للسؤال وتجهيز بديل من نفس المحور. السؤال البديل جاهز لـ START.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "تعذر إلغاء السؤال واستبداله",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel live-operator-panel">
      <div className="section-heading">
        <div>
          <p className="step-label">M4 — Live</p>
          <h2>التحكم بالجولة</h2>
        </div>
        <span className="live-phase">{phaseLabel(snapshot.phase)}</span>
      </div>

      {snapshot.round ? (
        <div className="live-round-map">
          <div>
            <span>Station A</span>
            <strong>{snapshot.round.teamA.name}</strong>
          </div>
          <b>VS</b>
          <div>
            <span>Station B</span>
            <strong>
              {snapshot.round.teamB?.name ?? "غير مستخدمة — SOLO"}
            </strong>
          </div>
        </div>
      ) : (
        <p className="empty-state">
          لا توجد جولة مجهزة حاليًا.
        </p>
      )}

      {snapshot.round ? (
        <div className="live-status-grid">
          <div>
            <span>تأكيد المحطات</span>
            <strong>
              {snapshot.stationsConfirmed ? "مؤكدة" : "بانتظار التأكيد"}
            </strong>
          </div>
          <div>
            <span>السؤال</span>
            <strong>{questionPosition ?? "—"} / 10</strong>
          </div>
          <div>
            <span>Station A</span>
            <strong>
              {snapshot.stationReadiness.teamAConnected
                ? "READY"
                : "OFFLINE"}
            </strong>
            <small>
              {snapshot.answerStatus.teamAReceived
                ? "تم استلام الإجابة"
                : "بانتظار الإجابة"}
            </small>
          </div>
          <div>
            <span>Station B</span>
            <strong>
              {!snapshot.stationReadiness.teamBRequired
                ? "SOLO — غير مطلوبة"
                : snapshot.stationReadiness.teamBConnected
                  ? "READY"
                  : "OFFLINE"}
            </strong>
            <small>
              {!snapshot.answerStatus.teamBRequired
                ? "غير مطلوبة"
                : snapshot.answerStatus.teamBReceived
                  ? "تم استلام الإجابة"
                  : "بانتظار الإجابة"}
            </small>
          </div>
        </div>
      ) : null}

      <OperatorHotkeys
        snapshot={snapshot}
        busy={busy}
        run={run}
        emergencyHold={emergencyHold}
        voidAndReplace={voidAndReplace}
      />

      <div className="actions live-actions">
        {(snapshot.phase === "IDLE" ||
          snapshot.phase === "ROUND_COMPLETE") &&
        snapshot.hasPendingRound ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/prepare-round",
                "تم تجهيز الجولة القادمة.",
              )
            }
          >
            تجهيز الجولة القادمة
          </button>
        ) : null}

        {snapshot.phase === "ROUND_READY" &&
        !snapshot.stationsConfirmed ? (
          <>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(
                  "/api/live/confirm-stations",
                  "تم تأكيد توزيع المحطات.",
                )
              }
            >
              تأكيد Station A / B
            </button>

            {(!snapshot.stationReadiness.teamAConnected ||
              (snapshot.stationReadiness.teamBRequired &&
                !snapshot.stationReadiness.teamBConnected)) ? (
              <button
                className="danger-outline"
                disabled={busy}
                onClick={() => void overrideStations()}
              >
                تجاوز جاهزية المحطات — طارئ
              </button>
            ) : null}
          </>
        ) : null}

        {snapshot.phase === "ROUND_READY" &&
        snapshot.stationsConfirmed ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/start-round",
                "بدأت الجولة.",
              )
            }
          >
            بدء الجولة
          </button>
        ) : null}

        {snapshot.phase === "ROUND_ACTIVE" ||
        snapshot.phase === "INTERMISSION" ||
        (snapshot.phase === "QUESTION_REVEAL" &&
          (snapshot.question?.position ?? 0) < 10) ? (
          <button
            className="primary live-start-button"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/start-next-question",
                "بدأ السؤال التالي مباشرةً بالعد التنازلي 3-2-1.",
              )
            }
          >
            السؤال التالي — 3 · 2 · 1
          </button>
        ) : null}

        {snapshot.phase === "QUESTION_READY" ? (
          <button
            className="primary live-start-button"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/start-question",
                "بدأ العد التنازلي 3-2-1.",
              )
            }
          >
            START — 3 · 2 · 1
          </button>
        ) : null}

        {snapshot.phase === "QUESTION_CLOSED" &&
        snapshot.closeReason !== "ALL_TEAMS_ANSWERED" &&
        snapshot.closeReason !== "SOLO_ANSWERED" &&
        snapshot.closeReason !== "TIMEOUT" &&
        snapshot.closeReason !== "SERVER_RESTART_RECOVERY" &&
        snapshot.closeReason !== "EMERGENCY_HOLD" ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/reveal",
                "تم إظهار الإجابة.",
              )
            }
          >
            Reveal الإجابة
          </button>
        ) : null}

        {questionPosition !== null &&
        [
          "QUESTION_READY",
          "QUESTION_CLOSED",
          "QUESTION_REVEAL",
          "INTERMISSION",
        ].includes(snapshot.phase) ? (
          <button
            className="danger-outline"
            disabled={busy}
            onClick={() => void voidAndReplace()}
          >
            VOID + استبدال بنفس المحور
          </button>
        ) : null}

        {snapshot.phase === "QUESTION_REVEAL" &&
        snapshot.question?.position === 10 ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/complete-round",
                "تم إنهاء الجولة.",
              )
            }
          >
            إنهاء الجولة
          </button>
        ) : null}

        {snapshot.qualificationComplete ? (
          <>
            {!snapshot.resultsAnnounced ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    "/api/live/results/announce",
                    "تم إعلان النتائج النهائية وإرسال Cue إلى Ableton.",
                  )
                }
              >
                إعلان النتائج
              </button>
            ) : (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    "/api/live/awards/start",
                    "تم إرسال Cue إعلان الجوائز إلى Ableton.",
                  )
                }
              >
                بدء إعلان الجوائز — OSC
              </button>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                window.open(
                  "/report?print=1",
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            >
              تصدير بيان النتائج PDF
            </button>
          </>
        ) : null}

        {(snapshot.phase === "QUESTION_COUNTDOWN" ||
          snapshot.phase === "QUESTION_ACTIVE") ? (
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => void emergencyHold()}
          >
            Emergency Hold — طارئ
          </button>
        ) : null}

        {(snapshot.phase === "ROUND_ACTIVE" ||
          snapshot.phase === "QUESTION_REVEAL") ? (
          <button
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/intermission",
                "تم تفعيل وضع الاستراحة.",
              )
            }
          >
            استراحة / Hold
          </button>
        ) : null}
      </div>

      {snapshot.phase === "QUESTION_COUNTDOWN" ? (
        <p className="locked-note">
          العد التنازلي شغال. السؤال بعده مخفي عن المتسابقين.
        </p>
      ) : null}

      {snapshot.phase === "QUESTION_ACTIVE" ? (
        <p className="locked-note">
          السؤال فعال. ينغلق عند اكتمال الإجابات المطلوبة أو انتهاء 25 ثانية.
        </p>
      ) : null}

      {snapshot.phase === "QUESTION_CLOSED" &&
      (snapshot.closeReason === "SERVER_RESTART_RECOVERY" ||
        snapshot.closeReason === "EMERGENCY_HOLD") ? (
        <div className="status-message error recovery-warning">
          <strong>
            {snapshot.closeReason === "EMERGENCY_HOLD"
              ? "Emergency Hold مفعل"
              : "Recovery مطلوب"}
          </strong>
          <span>
            لا يمكن Reveal لهذا السؤال. استخدم VOID + استبدال بنفس المحور
            ثم START من جديد.
          </span>
        </div>
      ) : null}

      {snapshot.phase === "QUESTION_CLOSED" &&
      (snapshot.closeReason === "ALL_TEAMS_ANSWERED" ||
        snapshot.closeReason === "SOLO_ANSWERED") ? (
        <p className="locked-note">
          اكتملت الإجابات المطلوبة. تم إرسال OSC وسيتم إعلان النتيجة
          تلقائيًا بعد لحظة قصيرة.
        </p>
      ) : null}

      {snapshot.phase === "QUESTION_CLOSED" &&
      snapshot.closeReason === "TIMEOUT" ? (
        <p className="locked-note">
          انتهى وقت الإجابة. سيتم إعلان النتيجة تلقائيًا بعد لحظة قصيرة.
        </p>
      ) : null}

      {snapshot.phase === "ROUND_COMPLETE" &&
      snapshot.qualificationComplete ? (
        <div className="reveal-answer">
          <strong>انتهت جميع جولات التصفيات</strong>
          <span>
            {snapshot.resultsAnnounced
              ? "تم إعلان النتائج النهائية."
              : "النتائج محفوظة ومخفية. اضغط «إعلان النتائج» عند استعداد المقدم."}
          </span>
        </div>
      ) : null}

      <StatusMessage error={error} message={message} />
    </section>
  );
}

function OfficialResultsReport({
  ranking,
  settings,
  snapshot,
}: {
  ranking: QualificationRankingSnapshot | null;
  settings: AudienceDisplaySettings | null;
  snapshot: LiveSnapshot | null;
}) {
  const autoPrintRequested = useMemo(
    () =>
      new URLSearchParams(window.location.search).get("print") ===
      "1",
    [],
  );
  const autoPrintStarted = useRef(false);
  const [exportedAt] = useState(() => new Date());

  const reportReady =
    ranking !== null &&
    settings !== null &&
    snapshot !== null &&
    snapshot.qualificationComplete;

  useEffect(() => {
    document.title = "بيان النتائج الرسمي - مسابقة بنك المعلومات";

    if (
      !autoPrintRequested ||
      autoPrintStarted.current ||
      !reportReady
    ) {
      return;
    }

    autoPrintStarted.current = true;
    let cancelled = false;

    const waitForReportPaint = async () => {
      const images = Array.from(document.images);

      await Promise.all(
        images.map(
          async (image) => {
            if (!image.complete) {
              await new Promise<void>((resolve) => {
                const finish = () => resolve();
                image.addEventListener("load", finish, { once: true });
                image.addEventListener("error", finish, { once: true });
              });
            }

            try {
              await image.decode();
            } catch {
              // A failed optional logo must not block the report.
            }
          },
        ),
      );

      try {
        await document.fonts.ready;
      } catch {
        // Font readiness is best-effort; browser fallback fonts remain printable.
      }

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve());
        });
      });

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 500);
      });

      if (cancelled) return;

      window.focus();
      window.print();
    };

    void waitForReportPaint();

    return () => {
      cancelled = true;
    };
  }, [autoPrintRequested, reportReady]);

  if (!ranking || !settings || !snapshot) {
    return (
      <section className="official-report report-loading" dir="rtl">
        <strong>جاري تجهيز بيان النتائج الرسمي...</strong>
      </section>
    );
  }

  if (!snapshot.qualificationComplete) {
    return (
      <section className="official-report report-loading" dir="rtl">
        <strong>بيان النتائج غير متاح قبل اكتمال جميع جولات التصفيات.</strong>
        <a className="button-link" href="/operator">
          العودة إلى لوحة التحكم
        </a>
      </section>
    );
  }

  const finalEntries = ranking.entries.filter(
    (entry) => entry.rank !== null,
  );
  const topThree = finalEntries.slice(0, 3);
  const issuedAt = new Intl.DateTimeFormat("ar-IQ", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(exportedAt);

  return (
    <section className="official-report" dir="rtl">
      <div className="report-toolbar">
        <a className="button-link" href="/operator">
          العودة إلى لوحة التحكم
        </a>
        <button className="primary" onClick={() => window.print()}>
          طباعة / حفظ PDF
        </button>
      </div>

      <header className="report-letterhead">
        <div className="report-logo">
          {settings.universityLogoUrl ? (
            <img
              src={settings.universityLogoUrl}
              alt="شعار جامعة بابل"
            />
          ) : null}
        </div>

        <div className="report-heading">
          <h1>{settings.eventTitle}</h1>
          {settings.eventSubtitle ? (
            <p>{settings.eventSubtitle}</p>
          ) : null}
          <h2>بيان النتائج الرسمي - مرحلة التصفيات</h2>
        </div>

        <div className="report-logo">
          {settings.departmentLogoUrl ? (
            <img
              src={settings.departmentLogoUrl}
              alt="شعار قسم النشاطات الطلابية"
            />
          ) : null}
        </div>
      </header>

      <div className="report-patronage">
        <strong>{PATRONAGE_LINE}</strong>
        <strong>{SUPERVISION_LINE}</strong>
      </div>

      <div className="report-meta">
        <span>
          <b>عدد الكليات المشاركة:</b> {finalEntries.length}
        </span>
        <span>
          <b>تاريخ ووقت إصدار البيان:</b> {issuedAt}
        </span>
        {settings.venue ? (
          <span>
            <b>المكان:</b> {settings.venue}
          </span>
        ) : null}
        {settings.season ? (
          <span>
            <b>الموسم:</b> {settings.season}
          </span>
        ) : null}
      </div>

      <section className="report-top-three">
        {topThree.map((entry) => (
          <article
            className={[
              "report-podium-card",
              entry.rank === 1 ? "first" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={entry.college.id}
          >
            <span>المركز {entry.rank}</span>
            <strong>{entry.college.name}</strong>
            <b>{entry.scorePoints} نقطة</b>
            <small>
              مجموع زمن الإجابات:{" "}
              {(entry.totalResponseTimeMs / 1000).toFixed(3)} ثانية
            </small>
          </article>
        ))}
      </section>

      <h3 className="report-table-title">
        {settings.copy.finalRankingTitle}
      </h3>

      <table className="official-results-table">
        <thead>
          <tr>
            <th>المركز</th>
            <th>الكلية</th>
            <th>المجموع</th>
            <th>مجموع زمن الإجابات</th>
            <th>الإجابات الصحيحة</th>
            <th>الإجابات الخاطئة</th>
          </tr>
        </thead>
        <tbody>
          {finalEntries.map((entry) => (
            <tr
              key={entry.college.id}
              className={
                (entry.rank ?? 99) <= 3
                  ? "report-top-row"
                  : undefined
              }
            >
              <td>{entry.rank}</td>
              <td>{entry.college.name}</td>
              <td>{entry.scorePoints} نقطة</td>
              <td>
                {(entry.totalResponseTimeMs / 1000).toFixed(3)} ثانية
              </td>
              <td>{entry.correctAnswers}</td>
              <td>{entry.wrongAnswers}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="report-footer">
        <span>
          تم إصدار هذا البيان من نظام مسابقة بنك المعلومات اعتمادًا
          على النتائج المسجلة في النظام بعد اكتمال التصفيات.
        </span>
        <span>{settings.footerText}</span>
      </footer>
    </section>
  );
}


function TeamLivePanel({
  snapshot,
  teamState,
  connected,
  onSubmit,
}: {
  snapshot: LiveSnapshot | null;
  teamState: LiveTeamSubmissionState | null;
  connected: boolean;
  onSubmit: (option: "A" | "B" | "C" | "D") => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [busyOption, setBusyOption] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    setServerOffsetMs(snapshot.serverNowEpochMs - Date.now());
  }, [snapshot]);

  useEffect(() => {
    if (
      snapshot?.phase !== "QUESTION_COUNTDOWN" &&
      snapshot?.phase !== "QUESTION_ACTIVE"
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 100);

    return () => window.clearInterval(timer);
  }, [snapshot?.phase]);

  if (!snapshot) {
    return (
      <section className="team-live-screen">
        <h2>بانتظار السيرفر...</h2>
      </section>
    );
  }

  const station = teamState?.station ?? "A";
  const assignedCollege =
    station === "A"
      ? snapshot.round?.teamA ?? null
      : snapshot.round?.teamB ?? null;

  const teamRevealResult =
    snapshot.revealResults === null
      ? null
      : station === "A"
        ? snapshot.revealResults.teamA
        : snapshot.revealResults.teamB;

  const serverNow = now + serverOffsetMs;
  const countdownValue =
    snapshot.phase === "QUESTION_COUNTDOWN" &&
    snapshot.countdownStartedAtEpochMs !== null
      ? Math.max(
          1,
          Math.ceil(
            (snapshot.countdownStartedAtEpochMs + 3000 - serverNow) /
              1000,
          ),
        )
      : null;

  const remainingMs =
    snapshot.phase === "QUESTION_ACTIVE" &&
    snapshot.questionDeadlineEpochMs !== null
      ? Math.max(0, snapshot.questionDeadlineEpochMs - serverNow)
      : null;

  const remainingSeconds =
    remainingMs === null ? null : Math.ceil(remainingMs / 1000);

  const submit = async (option: "A" | "B" | "C" | "D") => {
    setBusyOption(option);
    setSubmitError(null);

    try {
      await onSubmit(option);
    } catch (caught) {
      setSubmitError(
        caught instanceof Error
          ? caught.message
          : "تعذر إرسال الإجابة",
      );
    } finally {
      setBusyOption(null);
    }
  };

  if (!teamState?.required && snapshot.round) {
    return (
      <section className="team-live-screen team-waiting">
        <p className="team-station-label">Station {station}</p>
        <h2>هذه المحطة غير مستخدمة في الجولة الفردية</h2>
        <p>ابقَ على الصفحة. سيتم تحديثها تلقائيًا عند الجولة التالية.</p>
      </section>
    );
  }

  return (
    <section className="team-live-screen">
      <div className="team-live-header">
        <div>
          <p className="team-station-label">Station {station}</p>
          <h2>{assignedCollege?.name ?? "بانتظار تعيين الكلية"}</h2>
        </div>
        <span className={connected ? "team-online" : "team-offline"}>
          {connected ? "متصل" : "غير متصل"}
        </span>
      </div>

      {snapshot.phase === "QUESTION_COUNTDOWN" ? (
        <div className="team-countdown">
          {countdownValue}
        </div>
      ) : null}

      {snapshot.phase === "QUESTION_READY" ? (
        <div className="team-waiting-card">
          السؤال {snapshot.question?.position ?? "—"} جاهز
          <strong>بانتظار START من النظام</strong>
        </div>
      ) : null}

      {snapshot.phase === "QUESTION_ACTIVE" ||
      snapshot.phase === "QUESTION_CLOSED" ||
      snapshot.phase === "QUESTION_REVEAL" ? (
        <>
          <div className="team-question-meta">
            <span>سؤال {snapshot.question?.position ?? "—"} / 10</span>
            <span>{snapshot.question?.categoryName ?? ""}</span>
            {remainingSeconds !== null ? (
              <strong>{remainingSeconds} ثانية</strong>
            ) : (
              <strong>{phaseLabel(snapshot.phase)}</strong>
            )}
          </div>

          <h3 className="team-question">
            {snapshot.question?.prompt ?? ""}
          </h3>

          <div className="team-options">
            {(["A", "B", "C", "D"] as const).map((option) => {
              const value = snapshot.question?.options?.[option] ?? "";
              const selected = teamState?.selectedOption === option;
              const correct =
                snapshot.phase === "QUESTION_REVEAL" &&
                snapshot.question?.correctOption === option;
              const wrong =
                snapshot.phase === "QUESTION_REVEAL" &&
                selected &&
                snapshot.question?.correctOption !== null &&
                snapshot.question?.correctOption !== option;

              return (
                <button
                  key={option}
                  className={[
                    "team-option",
                    selected ? "selected" : "",
                    correct ? "correct" : "",
                    wrong ? "wrong" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={
                    snapshot.phase !== "QUESTION_ACTIVE" ||
                    Boolean(teamState?.locked) ||
                    busyOption !== null
                  }
                  onClick={() => void submit(option)}
                >
                  <b>{option}</b>
                  <span>{value}</span>
                </button>
              );
            })}
          </div>

          {teamState?.locked ? (
            <div
              className={[
                "answer-locked",
                snapshot.phase === "QUESTION_REVEAL" &&
                snapshot.question?.correctOption ===
                  teamState.selectedOption
                  ? "correct"
                  : "",
                snapshot.phase === "QUESTION_REVEAL" &&
                snapshot.question?.correctOption !== null &&
                snapshot.question?.correctOption !==
                  teamState.selectedOption
                  ? "wrong"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {snapshot.phase === "QUESTION_REVEAL" ? (
                <strong>
                  {snapshot.question?.correctOption ===
                  teamState.selectedOption
                    ? "إجابتك صحيحة"
                    : "إجابتك غير صحيحة"}
                </strong>
              ) : (
                <>تم تثبيت الإجابة: {teamState.selectedOption}</>
              )}
              {teamState.responseTimeMs !== null
                ? ` — ${(teamState.responseTimeMs / 1000).toFixed(3)} ثانية`
                : ""}
              {snapshot.phase === "QUESTION_REVEAL" &&
              teamRevealResult !== null
                ? ` — ${teamRevealResult.scorePoints} نقطة`
                : ""}
            </div>
          ) : null}

          {snapshot.phase === "QUESTION_REVEAL" &&
          teamRevealResult?.answered === false ? (
            <div className="answer-locked wrong unanswered-result">
              <strong>لم تتم الإجابة</strong>
              <span>0 نقطة</span>
            </div>
          ) : null}
        </>
      ) : null}

      {snapshot.phase === "QUESTION_CLOSED" && !teamState?.locked ? (
        <div className="team-waiting-card">
          انتهى استقبال الإجابات
        </div>
      ) : null}

      {snapshot.phase === "QUESTION_REVEAL" ? (
        <div className="reveal-answer">
          <span>الإجابة الصحيحة</span>
          <strong>
            {snapshot.question?.correctOption &&
            snapshot.question?.options
              ? snapshot.question.options[
                  snapshot.question.correctOption
                ]
              : "—"}
          </strong>
          {snapshot.question?.correctOption ? (
            <small>
              الخيار {snapshot.question.correctOption}
            </small>
          ) : null}
        </div>
      ) : null}

      {![
        "QUESTION_READY",
        "QUESTION_COUNTDOWN",
        "QUESTION_ACTIVE",
        "QUESTION_CLOSED",
        "QUESTION_REVEAL",
      ].includes(snapshot.phase) ? (
        <div className="team-waiting-card">
          <strong>{phaseLabel(snapshot.phase)}</strong>
          <span>سيظهر السؤال تلقائيًا عند بدء النظام.</span>
        </div>
      ) : null}

      {submitError ? (
        <div className="status-message error">{submitError}</div>
      ) : null}
    </section>
  );
}

export function App() {
  const surface = useMemo(() => surfaceFromPath(window.location.pathname), []);
  const role = useMemo(() => roleForSurface(surface), [surface]);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);
  const [competition, setCompetition] =
    useState<CompetitionSetupSnapshot | null>(null);
  const [questionBank, setQuestionBank] =
    useState<QuestionBankSummary | null>(null);
  const [questionAllocation, setQuestionAllocation] =
    useState<QuestionAllocationSummary | null>(null);
  const [drawPresentation, setDrawPresentation] =
    useState<DrawPresentationEvent | null>(null);
  const [liveSnapshot, setLiveSnapshot] =
    useState<LiveSnapshot | null>(null);
  const [teamSubmission, setTeamSubmission] =
    useState<LiveTeamSubmissionState | null>(null);
  const [ranking, setRanking] =
    useState<QualificationRankingSnapshot | null>(null);
  const [audienceSettings, setAudienceSettings] =
    useState<AudienceDisplaySettings | null>(null);
  const [audiencePresentation, setAudiencePresentation] =
    useState<AudiencePresentationSnapshot | null>(null);
  const [liveSocket, setLiveSocket] =
    useState<ReturnType<typeof io> | null>(null);
  const [effectiveRole, setEffectiveRole] =
    useState<ClientRole>("unknown");
  const [runtimeMode, setRuntimeMode] =
    useState<RuntimeMode>("official");

  useEffect(() => {
    const displayMode = surface === "display";
    const teamMode = surface === "team-a" || surface === "team-b";

    document.documentElement.classList.toggle(
      "display-mode",
      displayMode,
    );
    document.body.classList.toggle(
      "display-mode",
      displayMode,
    );
    document.documentElement.classList.toggle(
      "team-mode",
      teamMode,
    );
    document.body.classList.toggle(
      "team-mode",
      teamMode,
    );

    return () => {
      document.documentElement.classList.remove("display-mode");
      document.body.classList.remove("display-mode");
      document.documentElement.classList.remove("team-mode");
      document.body.classList.remove("team-mode");
    };
  }, [surface]);

  const stationToken = useMemo(() => {
    if (role !== "team-a" && role !== "team-b") {
      return null;
    }

    const key = `uniquiz:${role}:token`;
    const queryToken = new URLSearchParams(
      window.location.search,
    ).get("token");

    if (queryToken) {
      window.localStorage.setItem(key, queryToken);
      return queryToken;
    }

    return window.localStorage.getItem(key);
  }, [role]);

  useEffect(() => {
    const socket = io({
      auth: {
        role,
        token: stationToken,
      },
    });
    setLiveSocket(socket);

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      setEffectiveRole("unknown");
    });
    socket.on(
      "server:hello",
      (payload: {
        role: ClientRole;
        mode: RuntimeMode;
      }) => {
        setEffectiveRole(payload.role);
        setRuntimeMode(payload.mode);
      },
    );
    socket.on("presence:snapshot", (snapshot: PresenceSnapshot) => {
      setPresence(snapshot);
    });
    socket.on(
      "competition:snapshot",
      (snapshot: CompetitionSetupSnapshot) => {
        setCompetition(snapshot);
      },
    );
    socket.on(
      "question-bank:snapshot",
      (snapshot: QuestionBankSummary) => {
        setQuestionBank(snapshot);
      },
    );
    socket.on(
      "question-allocation:snapshot",
      (snapshot: QuestionAllocationSummary) => {
        setQuestionAllocation(snapshot);
      },
    );
    socket.on(
      "live:snapshot",
      (snapshot: LiveSnapshot) => {
        setLiveSnapshot(snapshot);
      },
    );
    socket.on(
      "ranking:snapshot",
      (snapshot: QualificationRankingSnapshot) => {
        setRanking(snapshot);
      },
    );
    socket.on(
      "audience:settings",
      (settings: AudienceDisplaySettings) => {
        setAudienceSettings(settings);
      },
    );
    socket.on(
      "audience:presentation",
      (presentation: AudiencePresentationSnapshot) => {
        setAudiencePresentation(presentation);
      },
    );
    socket.on(
      "live:team-submission",
      (state: LiveTeamSubmissionState) => {
        setTeamSubmission(state);
      },
    );
    socket.on(
      "draw:presentation:start",
      (event: DrawPresentationEvent) => {
        setDrawPresentation(event);

        const duration = 1600 + event.rounds.length * 850;
        window.setTimeout(() => {
          setDrawPresentation((current) =>
            current?.startedAt === event.startedAt ? null : current,
          );
        }, duration);
      },
    );

    return () => {
      setLiveSocket(null);
      socket.disconnect();
    };
  }, [role, stationToken]);

  const showPresence = surface === "operator";

  const submitTeamAnswer = async (
    option: "A" | "B" | "C" | "D",
  ) => {
    if (!liveSocket?.connected) {
      throw new Error("الاتصال بالسيرفر غير متوفر.");
    }

    if (effectiveRole !== role) {
      throw new Error(
        "رمز دخول المحطة غير موجود أو غير صحيح.",
      );
    }

    await new Promise<void>((resolve, reject) => {
      liveSocket.emit(
        "team:submit-answer",
        { option },
        (result: { ok?: boolean; error?: string }) => {
          if (result?.ok) {
            resolve();
            return;
          }

          reject(
            new Error(
              result?.error ?? "ANSWER_SUBMISSION_FAILED",
            ),
          );
        },
      );
    });
  };

  return (
    <main
      className={
        surface === "display"
          ? "display-shell"
          : surface === "report"
            ? "report-shell"
            : surface === "team-a" || surface === "team-b"
              ? "team-shell"
              : "shell"
      }
    >
      {runtimeMode === "rehearsal" ? (
        <div className="rehearsal-banner">
          REHEARSAL · تدريب — البيانات والنتائج معزولة عن الرسمي
        </div>
      ) : null}

      {surface !== "display" &&
      surface !== "report" &&
      surface !== "team-a" &&
      surface !== "team-b" ? (
        <section className="hero">
          <p className="eyebrow">University Knowledge Competition</p>
          <h1>{surfaceTitles[surface]}</h1>
          <p className="subtitle">
            {surface === "setup" || surface === "draw"
              ? "M2 — Participants & Draw"
              : "Realtime Competition Runtime"}
          </p>
          <div className="connection">
            <span
              className={
                connected ? "dot online-bg" : "dot offline-bg"
              }
            />
            {connected
              ? "متصل بالسيرفر"
              : "جاري الاتصال بالسيرفر"}
          </div>

          {surface === "setup" ? (
            <div className="surface-switcher">
              <a className="button-link" href="/draw">
                القرعة الرسمية
              </a>
              <a className="button-link" href="/operator">
                الانتقال إلى لوحة التحكم
              </a>
            </div>
          ) : surface === "draw" ? (
            <div className="surface-switcher">
              <a className="button-link" href="/setup">
                العودة إلى الإعدادات
              </a>
              <a className="button-link" href="/operator">
                الانتقال إلى لوحة التحكم
              </a>
            </div>
          ) : surface === "operator" ? (
            <div className="surface-switcher">
              <a className="button-link" href="/setup">
                الانتقال إلى الإعدادات
              </a>
              <a className="button-link" href="/draw">
                القرعة الرسمية
              </a>
            </div>
          ) : null}
        </section>
      ) : null}

      {surface === "setup" && competition ? (
        <>
          <BulkImportPanel questionBank={questionBank} />
          <SetupSurface snapshot={competition} />
          <DrawSurface snapshot={competition} />
          <QuestionAllocationPanel allocation={questionAllocation} />
          <AudienceSettingsPanel settings={audienceSettings} />
          <ResetAllCompetitionPanel />
        </>
      ) : null}

      {surface === "draw" && competition ? (
        <DrawSurface snapshot={competition} />
      ) : null}

      {surface === "display" &&
      competition &&
      audienceSettings ? (
        audiencePresentation?.active &&
        audiencePresentation.kind === "CUSTOM" &&
        audiencePresentation.title === PRESHOW_PRESENTATION_MARKER ? (
          <AudienceSceneTransition
            sceneKey={`presentation:${audiencePresentation.updatedAt}`}
          >
            <AudiencePreShowSurface
              settings={audienceSettings}
              categories={questionBank?.categories ?? []}
              presentationKey={audiencePresentation.updatedAt}
            />
          </AudienceSceneTransition>
        ) : (
        <AudienceBroadcastFrame settings={audienceSettings}>
          {audiencePresentation?.active ? (
            <AudienceSceneTransition
              sceneKey={`presentation:${audiencePresentation.updatedAt}`}
            >
              <AudienceAnnouncementSurface
                presentation={audiencePresentation}
              />
            </AudienceSceneTransition>
          ) : liveSnapshot &&
          liveSnapshot.phase !== "IDLE" ? (
            <AudienceSceneTransition
              sceneKey={[
                "live",
                liveSnapshot.phase,
                liveSnapshot.round?.id ?? 0,
                liveSnapshot.question?.position ?? 0,
              ].join(":")}
            >
              <div className="audience-broadcast-layout">
                <AudienceLiveSurface
                  snapshot={liveSnapshot}
                  competition={competition}
                  ranking={ranking}
                  settings={audienceSettings}
                />
                <AudienceRankingSidebar
                  ranking={ranking}
                  settings={audienceSettings}
                />
              </div>
            </AudienceSceneTransition>
          ) : (
            <AudienceSceneTransition
              sceneKey={[
                "draw",
                competition.participantsLocked ? "locked" : "open",
                competition.rounds.length,
                drawPresentation?.startedAt ?? "stable",
              ].join(":")}
            >
              <AudienceDrawSurface
                snapshot={competition}
                presentation={drawPresentation}
                settings={audienceSettings}
              />
            </AudienceSceneTransition>
          )}
        </AudienceBroadcastFrame>
        )
      ) : null}

      {surface === "report" ? (
        <OfficialResultsReport
          ranking={ranking}
          settings={audienceSettings}
          snapshot={liveSnapshot}
        />
      ) : null}

      {surface === "operator" ? (
        <>
          <PresentationControlPanel settings={audienceSettings} />
          <OperationsPreflightPanel />
          <OperatorLivePanel snapshot={liveSnapshot} />
          <StationAccessPanel />
        </>
      ) : null}

      {surface === "stations" ? (
        <StationPortal />
      ) : null}

      {surface === "team-a" || surface === "team-b" ? (
        <TeamLivePanel
          snapshot={liveSnapshot}
          teamState={teamSubmission}
          connected={
            connected && effectiveRole === role
          }
          onSubmit={submitTeamAnswer}
        />
      ) : null}

      {showPresence ? (
        <section className="panel">
          <h2>حالة المحطات</h2>
          <div className="presence-grid">
            {presence?.stations.map((station) => (
              <PresenceCard key={station.role} station={station} />
            )) ?? <p>بانتظار أول تحديث...</p>}
          </div>
        </section>
      ) : null}

      {surface !== "setup" &&
      surface !== "draw" &&
      surface !== "operator" &&
      surface !== "display" &&
      surface !== "report" &&
      surface !== "stations" &&
      surface !== "team-a" &&
      surface !== "team-b" ? (
        <section className="panel">
          <h2>جاهز للمرحلة التالية</h2>
          <p>
            هذه الواجهة ستتبدل تلقائياً بدون Refresh حسب حالة المسابقة.
          </p>
        </section>
      ) : null}
    </main>
  );
}
