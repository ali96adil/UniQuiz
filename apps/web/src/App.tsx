import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type {
  ClientRole,
  CompetitionSetupSnapshot,
  PresenceSnapshot,
  QualificationRound,
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

export function App() {
  const surface = useMemo(() => surfaceFromPath(window.location.pathname), []);
  const role = useMemo(() => roleForSurface(surface), [surface]);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);
  const [competition, setCompetition] =
    useState<CompetitionSetupSnapshot | null>(null);

  useEffect(() => {
    const socket = io({
      auth: { role },
    });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("presence:snapshot", (snapshot: PresenceSnapshot) => {
      setPresence(snapshot);
    });
    socket.on(
      "competition:snapshot",
      (snapshot: CompetitionSetupSnapshot) => {
        setCompetition(snapshot);
      },
    );

    return () => {
      socket.disconnect();
    };
  }, [role]);

  const showPresence = surface === "operator";

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
        <SetupSurface snapshot={competition} />
      ) : null}

      {surface === "draw" && competition ? (
        <DrawSurface snapshot={competition} />
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
      surface !== "operator" ? (
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
