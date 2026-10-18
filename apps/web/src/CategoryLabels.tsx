import { useEffect, useState } from "react";
import type { QuestionBankSummary } from "@uniquiz/shared";

export function CategoryLabelsPanel({
  questionBank,
}: {
  questionBank: QuestionBankSummary | null;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts(Object.fromEntries(
      (questionBank?.categories ?? []).map((category) => [category.key, category.name]),
    ));
  }, [questionBank]);

  const save = async (key: string) => {
    const displayName = drafts[key]?.trim();
    if (!displayName) {
      setError("تسمية العرض مطلوبة.");
      return;
    }
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/question-bank/categories/" + encodeURIComponent(key) + "/display-name",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName }),
        },
      );
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error ?? "تعذر حفظ تسمية المحور");
      }
      setMessage("تم تحديث اسم المحور الظاهر للجمهور والتقارير دون تغيير اسمه الداخلي.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر الحفظ");
    } finally {
      setBusyKey(null);
    }
  };

  if (!questionBank || questionBank.categories.length === 0) return null;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>تسميات المحاور الظاهرة للجمهور</h2>
          <p className="muted">
            الاسم الداخلي يبقى للإدارة فقط. مثال: «رياضة تخصصية» يظهر للجمهور «رياضة».
          </p>
        </div>
      </div>
      {questionBank.categories.map((category) => (
        <div className="import-upload" key={category.key}>
          <div>
            <strong>{category.internalName}</strong>
            <p className="muted">المفتاح: {category.key}</p>
          </div>
          <input
            type="text"
            aria-label={"اسم العرض للمحور " + category.internalName}
            value={drafts[category.key] ?? category.name}
            disabled={busyKey !== null}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [category.key]: event.target.value,
              }))
            }
          />
          <button
            disabled={busyKey !== null || !drafts[category.key]?.trim()}
            onClick={() => void save(category.key)}
          >
            حفظ اسم العرض
          </button>
        </div>
      ))}
      {error ? <div className="status-message error">{error}</div> : null}
      {message ? <div className="status-message success">{message}</div> : null}
    </section>
  );
}
