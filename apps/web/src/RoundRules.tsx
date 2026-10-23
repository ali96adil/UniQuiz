import { useEffect, useMemo, useState } from "react";
import type { QuestionAllocationSummary, QuestionBankSummary } from "@uniquiz/shared";

interface CategoryQuota {
  categoryKey: string;
  questions: number;
}
interface Rules {
  questionsPerRound: number;
  categories: CategoryQuota[];
}

export function RoundRulesPanel({
  questionBank,
  allocation,
}: {
  questionBank: QuestionBankSummary | null;
  allocation: QuestionAllocationSummary | null;
}) {
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/competition/rules");
        if (!response.ok) throw new Error("تعذر تحميل إعدادات الجولات");
        const rules = await response.json() as Rules;
        setDraft(Object.fromEntries(rules.categories.map((row) => [row.categoryKey, row.questions])));
        setLoaded(true);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "تعذر تحميل إعدادات الجولات");
      }
    })();
  }, []);

  const categories = useMemo(
    () => (questionBank?.categories ?? []).map((category) => ({
      ...category,
      quota: draft[category.key] ?? 0,
    })),
    [questionBank, draft],
  );
  const chosen = categories.filter((category) => category.quota > 0);
  const total = chosen.reduce((sum, item) => sum + item.quota, 0);
  const locked = allocation?.rounds.some((round) => round.locked) ?? false;

  const save = async () => {
    if (total < 1 || total > 100 || chosen.some((category) => !Number.isInteger(category.quota))) {
      setError("اختَر من 1 إلى 100 سؤال للجولة، بأعداد صحيحة.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/competition/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categories: chosen.map((item) => ({
            categoryKey: item.key,
            questions: item.quota,
          })),
        }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string; message?: string };
        throw new Error(payload.message ?? payload.error ?? "تعذر حفظ توزيع الأسئلة");
      }
      setMessage("تم اعتماد التوزيع. سيستخدمه محرك الجولة ومحطات الإجابة وشاشة الجمهور.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر حفظ التوزيع");
    } finally {
      setBusy(false);
    }
  };

  if (!questionBank || !loaded) return null;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="step-label">قواعد البطولة</p>
          <h2>عدد الأسئلة والمحاور</h2>
          <p className="muted">
            لكل محور اسمه الداخلي الخاص. اختَر 0 لتعطيله بهذه المسابقة،
            أو 12 مثلاً لتكون كل الأسئلة من الرياضة التخصصية.
          </p>
        </div>
        <div>
          <strong>{total} سؤالاً لكل جولة</strong>
          <p className="muted">{chosen.length} محاور مختارة</p>
        </div>
      </div>
      <div className="audience-settings-grid">
        {categories.map((category) => (
          <label key={category.key}>
            <span>{category.internalName} (للجمهور: {category.name})</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={category.quota}
              disabled={busy || locked}
              onChange={(event) => {
                const n = Number(event.target.value);
                setDraft((current) => ({
                  ...current,
                  [category.key]: Number.isFinite(n) ? n : 0,
                }));
              }}
            />
          </label>
        ))}
      </div>
      {locked ? <p className="muted">إعدادات الجولات مقفلة بعد توزيع الأسئلة. لا يمكن تغييرها قبل فك التوزيع.</p> : null}
      <div className="actions">
        <button className="primary" disabled={busy || locked || total < 1 || total > 100} onClick={() => void save()}>
          حفظ قواعد الأسئلة
        </button>
      </div>
      {error ? <div className="status-message error">{error}</div> : null}
      {message ? <div className="status-message success">{message}</div> : null}
    </section>
  );
}
