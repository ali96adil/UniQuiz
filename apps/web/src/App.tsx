import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type {
  BulkImportPreview,
  ClientRole,
  CompetitionSetupSnapshot,
  DrawPresentationEvent,
  LiveSnapshot,
  LiveTeamSubmissionState,
  PresenceSnapshot,
  QualificationRound,
  QuestionAllocationSummary,
  QuestionBankSummary,
  StationPresence,
} from "@uniquiz/shared";

type Surface =
  | "home"
  | "setup"
  | "draw"
  | "operator"
  | "display"
  | "team-a"
  | "team-b";

const surfaceTitles: Record<Surface, string> = {
  home: "مسابقة بنك المعلومات",
  setup: "إعداد المسابقة",
  draw: "القرعة",
  operator: "لوحة التحكم",
  display: "شاشة الجمهور",
  "team-a": "محطة المتسابق A",
  "team-b": "محطة المتسابق B",
};

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

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await apiRequest("/api/import/apply", {
        method: "POST",
        body: JSON.stringify({
          previewId: preview.previewId,
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
          <p className="step-label">إدخال جماعي</p>
          <h2>استيراد Excel / CSV</h2>
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
              </span>
            ))}
          </div>
        </div>
      ) : null}

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
          <p className="step-label">M3</p>
          <h2>توزيع أسئلة الجولات</h2>
        </div>
        <span
          className={
            allocation.ready
              ? "preview-state valid"
              : "preview-state invalid"
          }
        >
          {allocation.ready ? "READY" : "NOT READY"}
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
                المتوفر {category.availableQuestions} / المطلوب{" "}
                {category.requiredQuestions}
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

  const saveParticipants = () =>
    run(
      () =>
        apiRequest("/api/setup/participants", {
          method: "PUT",
          body: JSON.stringify({
            collegeIds: [...selectedIds],
          }),
        }),
      "تم حفظ الكليات المشاركة.",
    );

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
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(collegeId)) next.delete(collegeId);
      else next.add(collegeId);
      return next;
    });
  };

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="step-label">الخطوة 1</p>
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
            <p className="step-label">الخطوة 2</p>
            <h2>اختيار المشاركين</h2>
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

        <div className="actions">
          <button
            disabled={
              snapshot.participantsLocked ||
              snapshot.colleges.length === 0 ||
              busy
            }
            onClick={() => void saveParticipants()}
          >
            حفظ المشاركين
          </button>

          {!snapshot.participantsLocked ? (
            <button
              className="primary"
              disabled={
                snapshot.participantCollegeIds.length < 2 || busy
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
          <p className="step-label">M2</p>
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


function AudienceDrawSurface({
  snapshot,
  presentation,
}: {
  snapshot: CompetitionSetupSnapshot;
  presentation: DrawPresentationEvent | null;
}) {
  const participantNames = snapshot.colleges
    .filter((college) => snapshot.participantCollegeIds.includes(college.id))
    .map((college) => college.name);

  if (!snapshot.participantsLocked) {
    return (
      <section className="audience-stage">
        <div className="audience-kicker">مسابقة بنك المعلومات</div>
        <h2 className="audience-title">أهلاً بكم</h2>
        <p className="audience-copy">بانتظار تثبيت الكليات المشاركة</p>
      </section>
    );
  }

  if (snapshot.rounds.length === 0) {
    return (
      <section className="audience-stage">
        <div className="audience-kicker">مرحلة القرعة</div>
        <h2 className="audience-title">القرعة الرسمية</h2>
        <p className="audience-copy">
          {participantNames.length} كلية مشاركة
        </p>
        <div className="audience-participants">
          {participantNames.map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <div className="draw-waiting">بانتظار إجراء القرعة</div>
      </section>
    );
  }

  const activePresentation = presentation?.rounds.length === snapshot.rounds.length;

  return (
    <section className="audience-stage">
      <div className="audience-kicker">
        {activePresentation ? "جاري إعلان القرعة" : "نتائج القرعة"}
      </div>
      <h2 className="audience-title">
        {activePresentation ? "الجولات" : "القرعة الرسمية"}
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
              جولة {round.order}
            </span>
            <div className="audience-matchup">
              <strong>{round.collegeA.name}</strong>
              <b>{round.collegeB ? "VS" : "SOLO"}</b>
              <strong>
                {round.collegeB?.name ?? "جولة فردية"}
              </strong>
            </div>
          </article>
        ))}
      </div>

      <div className="audience-footer-message">
        {activePresentation
          ? "يتم إعلان الجولات حسب ترتيب القرعة"
          : "تم اعتماد ترتيب الجولات"}
      </div>
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
            <span>Team A</span>
            <strong>
              {snapshot.answerStatus.teamAReceived
                ? "تم استلام الإجابة"
                : "بانتظار الإجابة"}
            </strong>
          </div>
          <div>
            <span>Team B</span>
            <strong>
              {!snapshot.answerStatus.teamBRequired
                ? "غير مطلوبة"
                : snapshot.answerStatus.teamBReceived
                  ? "تم استلام الإجابة"
                  : "بانتظار الإجابة"}
            </strong>
          </div>
        </div>
      ) : null}

      <div className="actions live-actions">
        {snapshot.phase === "IDLE" ||
        snapshot.phase === "ROUND_COMPLETE" ? (
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
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(
                "/api/live/prepare-question",
                "تم تجهيز السؤال التالي.",
              )
            }
          >
            تجهيز السؤال التالي
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

        {snapshot.phase === "QUESTION_CLOSED" ? (
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
          السؤال فعال. ينغلق عند اكتمال الإجابات المطلوبة أو انتهاء 45 ثانية.
        </p>
      ) : null}

      <StatusMessage error={error} message={message} />
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
          <strong>بانتظار START من الأوبريتر</strong>
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

              return (
                <button
                  key={option}
                  className={[
                    "team-option",
                    selected ? "selected" : "",
                    correct ? "correct" : "",
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
            <div className="answer-locked">
              تم تثبيت الإجابة: {teamState.selectedOption}
              {teamState.responseTimeMs !== null
                ? ` — ${(teamState.responseTimeMs / 1000).toFixed(3)} ثانية`
                : ""}
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
          الإجابة الصحيحة: {snapshot.question?.correctOption ?? "—"}
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
          <span>سيظهر السؤال تلقائيًا عند بدء الأوبريتر.</span>
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
  const [liveSocket, setLiveSocket] =
    useState<ReturnType<typeof io> | null>(null);
  const [effectiveRole, setEffectiveRole] =
    useState<ClientRole>("unknown");

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
      (payload: { role: ClientRole }) => {
        setEffectiveRole(payload.role);
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
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">University Knowledge Competition</p>
        <h1>{surfaceTitles[surface]}</h1>
        <p className="subtitle">
          {surface === "setup" || surface === "draw"
            ? "M2 — Participants & Draw"
            : "Realtime Competition Runtime"}
        </p>
        <div className="connection">
          <span className={connected ? "dot online-bg" : "dot offline-bg"} />
          {connected ? "متصل بالسيرفر" : "جاري الاتصال بالسيرفر"}
        </div>
      </section>

      {surface === "setup" && competition ? (
        <>
          <BulkImportPanel questionBank={questionBank} />
          <QuestionAllocationPanel allocation={questionAllocation} />
          <SetupSurface snapshot={competition} />
        </>
      ) : null}

      {surface === "draw" && competition ? (
        <DrawSurface snapshot={competition} />
      ) : null}

      {surface === "display" && competition ? (
        <AudienceDrawSurface
          snapshot={competition}
          presentation={drawPresentation}
        />
      ) : null}

      {surface === "operator" ? (
        <>
          <OperatorLivePanel snapshot={liveSnapshot} />
          <StationAccessPanel />
        </>
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
