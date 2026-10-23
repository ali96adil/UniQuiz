import { useEffect, useState } from "react";
import type { QuestionAllocationSummary, QuestionBankSummary } from "@uniquiz/shared";

interface RoundEditor {
  roundId: number;
  counts: Record<string, number>;
}

export function RoundOverridesPanel({
  allocation,
  questionBank,
}: {
  allocation: QuestionAllocationSummary | null;
  questionBank: QuestionBankSummary | null;
}) {
  const [editing, setEditing] = useState<RoundEditor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rounds = allocation?.rounds ?? [];
  const categories = questionBank?.categories ?? [];
  const hasLocked = rounds.some((round) => round.locked);
  useEffect(() => {
    if (editing && !rounds.some((round) => round.roundId === editing.roundId)) {
      setEditing(null);
    }
  }, [allocation]);

  const open = (roundId: number) => {
    const round = rounds.find((item) => item.roundId === roundId);
    if (!round) return;
    setError(null);
    setMessage(null);
    setEditing({
      roundId,
      counts: Object.fromEntries(
        categories.map((category) => [
          category.key, round.plannedCategoryCounts[category.key] ?? 0,
        ]),
      ),
    });
  };

  const save = async (restoreDefault = false) => {
    if (!editing) return;
    const selected = categories
      .map((category) => ({
        categoryKey: category.key,
        questions: editing.counts[category.key] ?? 0,
      }))
      .filter((quota) => quota.questions > 0);
    const total = selected.reduce((sum, item) => sum + item.questions, 0);
    if (!restoreDefault && (
      total < 1 || total > 100 ||
      selected.some((item) => !Number.isInteger(item.questions))
    )) {
      setError("مجموع أسئلة الجولة لازم يكون بين 1 و100، بأعداد صحيحة.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/competition/rounds/${editing.roundId}/rules`,
        {
          method: restoreDefault ? "DELETE" : "PUT",
          headers: { "content-type": "application/json" },
          ...(!restoreDefault ? { body: JSON.stringify({ categories: selected }) } : {}),
        },
      );
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "تعذر حفظ خطة الجولة");
      setEditing(null);
      setMessage(restoreDefault
        ? "تمت إعادة الجولة إلى القواعد الافتراضية للبطولة."
        : "تم حفظ توزيع هذه الجولة وحدها، دون التأثير على بقية الجولات.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر حفظ إعدادات الجولة");
    } finally {
      setBusy(false);
    }
  };

  if (!allocation || !questionBank || rounds.length === 0) return null;
  const currentTotal = editing
    ? Object.values(editing.counts).reduce((sum, count) => sum + count, 0)
    : 0;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="step-label">إعدادات الجولات</p>
          <h2>توزيع مخصص لكل جولة</h2>
          <p className="muted">
            كل جولة ممكن تكون من محور واحد أو عدة محاور، وبأي عدد أسئلة من 1 إلى 100.
            تظل قواعد البطولة الافتراضية مطبقة على الجولات التي لا تخصصها.
          </p>
        </div>
      </div>
      {hasLocked ? (
        <p className="muted">بعد قفل الأسئلة لا يمكن تعديل خطة الجولة، إلا إذا ألغيت التوزيع قبل بدء أي جولة.</p>
      ) : null}
      <div className="round-allocation-grid">
        {rounds.map((round) => (
          <div key={round.roundId} className="round-allocation">
            <strong>جولة {round.roundOrder}</strong>
            <span>{round.plannedQuestionCount} سؤالاً مخططاً</span>
            <small>{round.customized ? "خطة خاصة" : "حسب قواعد البطولة"}</small>
            <button
              disabled={busy || round.locked || hasLocked}
              onClick={() => open(round.roundId)}
            >
              تخصيص الأسئلة
            </button>
          </div>
        ))}
      </div>
      {editing ? (
        <div className="panel">
          <h3>جولة {rounds.find((r) => r.roundId === editing.roundId)?.roundOrder} — {currentTotal} سؤالاً</h3>
          <div className="audience-settings-grid">
            {categories.map((category) => (
              <label key={category.key}>
                <span>{category.internalName} — يظهر للجمهور: {category.name}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  disabled={busy}
                  value={editing.counts[category.key] ?? 0}
                  onChange={(event) => {
                    const raw = Number(event.target.value);
                    setEditing((current) => current === null ? current : ({
                      ...current,
                      counts: {
                        ...current.counts,
                        [category.key]: Number.isFinite(raw) ? raw : 0,
                      },
                    }));
                  }}
                />
              </label>
            ))}
          </div>
          <div className="actions">
            <button className="primary" disabled={busy || currentTotal < 1 || currentTotal > 100} onClick={() => void save(false)}>
              حفظ هذه الجولة
            </button>
            <button disabled={busy} onClick={() => void save(true)}>العودة للقواعد الافتراضية</button>
            <button disabled={busy} onClick={() => setEditing(null)}>إلغاء</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="status-message error">{error}</p> : null}
      {message ? <p className="status-message success">{message}</p> : null}
    </section>
  );
}
