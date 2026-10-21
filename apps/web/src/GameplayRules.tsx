import { useEffect, useState } from "react";
import type { CompetitionGameplayRules } from "@uniquiz/shared";

export function GameplayRulesPanel({
  locked,
  onSaved,
}: {
  locked: boolean;
  onSaved: (rules: CompetitionGameplayRules) => void;
}) {
  const [draft, setDraft] = useState<CompetitionGameplayRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/competition/gameplay")
      .then((response) => {
        if (!response.ok) throw new Error("تعذر قراءة إعدادات السؤال.");
        return response.json() as Promise<CompetitionGameplayRules>;
      })
      .then(setDraft)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "تعذر القراءة"));
  }, []);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/competition/gameplay", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json() as CompetitionGameplayRules & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "تعذر حفظ قواعد الوقت والنقاط.");
      setDraft(result);
      onSaved(result);
      setMessage("تم حفظ إعدادات وقت السؤال والنقاط لهذه المسابقة.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر الحفظ");
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    return <section className="panel"><h2>وقت السؤال والنقاط</h2>{error ? <p className="status-message error">{error}</p> : <p className="muted">جاري تحميل الإعدادات...</p>}</section>;
  }
  const disabled = busy || locked;
  const valid = Number.isInteger(draft.durationSeconds) &&
    draft.durationSeconds >= 5 && draft.durationSeconds <= 300 &&
    Number.isInteger(draft.correctPoints) &&
    draft.correctPoints >= 1 && draft.correctPoints <= 1000 &&
    Number.isInteger(draft.pointsLostPerSecond) &&
    draft.pointsLostPerSecond >= 0 && draft.pointsLostPerSecond <= 100;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="step-label">قواعد المسابقة</p>
          <h2>وقت السؤال واحتساب النقاط</h2>
          <p className="muted">الإعداد الافتراضي هو 25 ثانية، و25 نقطة تقل نقطة كل ثانية. تگدر تغير المدة وطريقة التقييم حسب البطولة.</p>
        </div>
      </div>
      <div className="audience-settings-grid">
        <label>
          <span>مدة السؤال بالثواني (5–300)</span>
          <input type="number" min={5} max={300} step={1} disabled={disabled}
            value={draft.durationSeconds}
            onChange={(event) => setDraft((current) => current && ({ ...current, durationSeconds: Number(event.target.value) }))} />
        </label>
        <label>
          <span>طريقة احتساب الإجابة الصحيحة</span>
          <select disabled={disabled} value={draft.scoringMode}
            onChange={(event) => setDraft((current) => current && ({
              ...current, scoringMode: event.target.value as CompetitionGameplayRules["scoringMode"],
            }))}>
            <option value="time_decay">النقاط تقل حسب وقت الإجابة</option>
            <option value="fixed">نقاط ثابتة للصحيحة</option>
          </select>
        </label>
        <label>
          <span>{draft.scoringMode === "fixed" ? "نقاط الإجابة الصحيحة" : "النقاط عند بداية السؤال"} (1–1000)</span>
          <input type="number" min={1} max={1000} step={1} disabled={disabled}
            value={draft.correctPoints}
            onChange={(event) => setDraft((current) => current && ({ ...current, correctPoints: Number(event.target.value) }))} />
        </label>
        <label>
          <span>ترتيب صعوبة الأسئلة داخل كل جولة</span>
          <select disabled={disabled} value={draft.difficultyMode ?? "random"}
            onChange={(event) => setDraft((current) => current && ({
              ...current, difficultyMode: event.target.value as "random" | "ascending",
            }))}>
            <option value="ascending">من السهل إلى الصعب (تصاعدي)</option>
            <option value="random">عشوائي (النظام الأصلي)</option>
          </select>
          <small className="muted">يُرتب النظام الأسئلة المختارة حسب مستوى الصعوبة، مع توزيع عشوائي ضمن المستوى الواحد. الأسئلة القديمة تبدأ بالمستوى 3 حتى تُصنَّف.</small>
        </label>
        {draft.scoringMode === "time_decay" ? (
          <label>
            <span>مقدار النقاط المخصومة لكل ثانية كاملة (0–100)</span>
            <input type="number" min={0} max={100} step={1} disabled={disabled}
              value={draft.pointsLostPerSecond}
              onChange={(event) => setDraft((current) => current && ({ ...current, pointsLostPerSecond: Number(event.target.value) }))} />
          </label>
        ) : null}
      </div>
      <p className="muted">
        {draft.scoringMode === "fixed"
          ? `كل إجابة صحيحة = ${draft.correctPoints} نقطة، والخاطئة أو المتأخرة = صفر.`
          : `تبدأ من ${draft.correctPoints} نقطة، وتنقص ${draft.pointsLostPerSecond} لكل ثانية كاملة، بحد أدنى نقطة واحدة للإجابة الصحيحة قبل انتهاء ${draft.durationSeconds} ثانية.`}
      </p>
      {locked ? <p className="status-message error">أُغلقت هذه القواعد بعد بدء أول جولة حفاظاً على عدالة النتائج.</p> : null}
      <div className="actions">
        <button className="primary" disabled={disabled || !valid} onClick={() => void save()}>حفظ قواعد الوقت والنقاط</button>
      </div>
      {error ? <p className="status-message error">{error}</p> : null}
      {message ? <p className="status-message success">{message}</p> : null}
    </section>
  );
}
