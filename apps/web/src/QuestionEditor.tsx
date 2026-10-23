import { useEffect, useState, type FormEvent } from "react";
import type { QuestionBankSummary } from "@uniquiz/shared";

type AnswerKey = "A" | "B" | "C" | "D";
type Difficulty = 1 | 2 | 3 | 4 | 5;
interface QuestionForm {
  categoryKey: string; prompt: string;
  optionA: string; optionB: string; optionC: string; optionD: string;
  correctOption: AnswerKey; difficulty: Difficulty; sourceRef: string | null;
}
interface QuestionRow extends QuestionForm {
  id: number; active: 0 | 1; createdAt: string;
}
interface Page { items: QuestionRow[]; total: number; page: number; pageSize: number; }
const levels = ["", "سهل جداً", "سهل", "متوسط", "صعب", "صعب جداً"];
function newQuestion(categoryKey: string): QuestionForm {
  return { categoryKey, prompt: "", optionA: "", optionB: "", optionC: "", optionD: "",
    correctOption: "A", difficulty: 3, sourceRef: null };
}
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(body.message || body.error || "تعذر إكمال العملية");
  return body;
}

export function QuestionEditorPanel({ questionBank }: { questionBank: QuestionBankSummary | null }) {
  const categories = questionBank?.categories ?? [];
  const [tab, setTab] = useState<"questions" | "categories">("questions");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [status, setStatus] = useState("active");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [reload, setReload] = useState(0);
  const [form, setForm] = useState<QuestionForm>(() => newQuestion(""));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [categoryKey, setCategoryKey] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [categoryDisplay, setCategoryDisplay] = useState("");
  const [editingCategory, setEditingCategory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (categories.length === 0) return;
    setForm((before) => before.categoryKey ? before : { ...before, categoryKey: categories[0]!.key });
  }, [questionBank]);

  useEffect(() => {
    const parameters = new URLSearchParams({
      page: String(page), pageSize: "25", status,
    });
    if (query.trim()) parameters.set("search", query.trim());
    if (category) parameters.set("categoryKey", category);
    if (difficulty) parameters.set("difficulty", difficulty);
    let cancelled = false;
    void requestJson<Page>("/api/question-bank/items?" + parameters.toString())
      .then((result) => { if (!cancelled) setData(result); })
      .catch((problem) => { if (!cancelled) setError(problem instanceof Error ? problem.message : "تعذر تحميل الأسئلة"); });
    return () => { cancelled = true; };
  }, [page, query, category, difficulty, status, reload, questionBank]);

  const clearAlerts = () => { setError(null); setNotice(null); };
  const resetQuestion = () => { setEditingId(null); setForm(newQuestion(categories[0]?.key ?? "")); };
  const saveQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); clearAlerts(); setBusy(true);
    try {
      const path = editingId === null ? "/api/question-bank/items" : "/api/question-bank/items/" + editingId;
      await requestJson(path, { method: editingId === null ? "POST" : "PUT",
        body: JSON.stringify(form) });
      setNotice(editingId === null ? "تمت إضافة السؤال إلى البنك." : "تم حفظ تعديل السؤال.");
      resetQuestion(); setReload((n) => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر الحفظ"); }
    finally { setBusy(false); }
  };
  const hideQuestion = async (id: number, active: boolean) => {
    if (!window.confirm(active ? "تعطيل هذا السؤال دون حذفه من السجل؟" : "إعادة تفعيل السؤال؟")) return;
    clearAlerts(); setBusy(true);
    try {
      await requestJson("/api/question-bank/items/" + id + (active ? "" : "/restore"),
        { method: active ? "DELETE" : "PATCH" });
      setNotice(active ? "تم تعطيل السؤال." : "تمت إعادة تفعيل السؤال.");
      if (id === editingId) resetQuestion();
      setReload((n) => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر تعديل الحالة"); }
    finally { setBusy(false); }
  };
  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); clearAlerts(); setBusy(true);
    try {
      await requestJson(editingCategory
          ? "/api/question-bank/categories/" + encodeURIComponent(categoryKey)
          : "/api/question-bank/categories",
        { method: editingCategory ? "PUT" : "POST",
          body: JSON.stringify(editingCategory
            ? { name: categoryName, displayName: categoryDisplay }
            : { key: categoryKey, name: categoryName, displayName: categoryDisplay }) });
      setNotice(editingCategory ? "تم تعديل المحور." : "تم إنشاء المحور.");
      setCategoryKey(""); setCategoryName(""); setCategoryDisplay(""); setEditingCategory(false);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ المحور"); }
    finally { setBusy(false); }
  };

  return (
    <div className="question-editor" dir="rtl">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="step-label">UniQuiz · Question Library</p>
            <h2>إدارة بنك الأسئلة والمحاور</h2>
            <p className="muted">إضافة وتعديل مباشر دون الحاجة إلى ملف Excel. الأسئلة المستخدمة تاريخياً محمية من التغيير؛ يمكن إنشاء نسخة منقحة.</p>
          </div>
          <div className="actions">
            <button type="button" className={tab === "questions" ? "primary" : ""} onClick={() => setTab("questions")}>الأسئلة</button>
            <button type="button" className={tab === "categories" ? "primary" : ""} onClick={() => setTab("categories")}>المحاور</button>
          </div>
        </div>
        {error ? <p className="status-message error" role="alert">{error}</p> : null}
        {notice ? <p className="status-message success" role="status">{notice}</p> : null}
        {tab === "categories" ? (
          <>
            <form className="editor-form" onSubmit={(event) => void saveCategory(event)}>
              <h3>{editingCategory ? "تعديل المحور" : "إنشاء محور جديد"}</h3>
              <div className="editor-fields">
                <label>مفتاح المحور (إنكليزي ثابت)
                  <input value={categoryKey} dir="ltr" required disabled={busy || editingCategory}
                    placeholder="sports_specialist" minLength={2} maxLength={100}
                    onChange={(e) => setCategoryKey(e.target.value)} />
                </label>
                <label>الاسم الداخلي للإدارة
                  <input value={categoryName} required maxLength={120} disabled={busy}
                    onChange={(e) => setCategoryName(e.target.value)} placeholder="رياضة تخصصية" />
                </label>
                <label>الاسم المعروض للجمهور
                  <input value={categoryDisplay} required maxLength={120} disabled={busy}
                    onChange={(e) => setCategoryDisplay(e.target.value)} placeholder="رياضة" />
                </label>
              </div>
              <div className="actions">
                <button className="primary" type="submit" disabled={busy}>حفظ المحور</button>
                {editingCategory ? <button type="button" onClick={() => {
                  setEditingCategory(false); setCategoryKey(""); setCategoryName(""); setCategoryDisplay("");
                }}>إلغاء التعديل</button> : null}
              </div>
            </form>
            <div className="editor-results">
              {categories.map((item) => (
                <div className="editor-item" key={item.key}>
                  <div><strong>{item.internalName}</strong><small>للجمهور: {item.name} · {item.questionCount} سؤال · {item.key}</small></div>
                  <button type="button" disabled={busy} onClick={() => {
                    setCategoryKey(item.key); setCategoryName(item.internalName);
                    setCategoryDisplay(item.name); setEditingCategory(true); clearAlerts();
                  }}>تعديل</button>
                </div>
              ))}
            </div>
            <p className="muted">استيراد المحاور جماعياً ما زال متوفراً عبر CSV أو Excel من صفحة إعداد المسابقة.</p>
          </>
        ) : (
          <>
            <form className="editor-form" onSubmit={(event) => void saveQuestion(event)}>
              <div className="section-heading"><h3>{editingId === null ? "سؤال جديد" : "تعديل السؤال #" + editingId}</h3>
                {editingId !== null ? <button type="button" onClick={resetQuestion}>إلغاء التحرير / سؤال جديد</button> : null}
              </div>
              <div className="editor-fields">
                <label>المحور
                  <select required disabled={busy} value={form.categoryKey}
                    onChange={(e) => setForm((f) => ({ ...f, categoryKey: e.target.value }))}>
                    <option value="">اختر المحور</option>
                    {categories.map((c) => <option key={c.key} value={c.key}>{c.internalName}</option>)}
                  </select>
                </label>
                <label>مستوى الصعوبة
                  <select disabled={busy} value={form.difficulty}
                    onChange={(e) => setForm((f) => ({ ...f, difficulty: Number(e.target.value) as Difficulty }))}>
                    {[1,2,3,4,5].map((n) => <option value={n} key={n}>{n} — {levels[n]}</option>)}
                  </select>
                </label>
                <label>مرجع السؤال (اختياري)
                  <input disabled={busy} value={form.sourceRef ?? ""} maxLength={250}
                    onChange={(e) => setForm((f) => ({ ...f, sourceRef: e.target.value || null }))} />
                </label>
              </div>
              <label className="editor-wide">نص السؤال
                <textarea required minLength={3} maxLength={2000} rows={3} disabled={busy}
                  value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} />
              </label>
              <div className="editor-fields">
                {(["A","B","C","D"] as AnswerKey[]).map((letter) => {
                  const field = ("option" + letter) as "optionA"|"optionB"|"optionC"|"optionD";
                  return <label key={letter}>الخيار {letter}
                    <input required maxLength={500} disabled={busy} value={form[field]}
                      onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} />
                  </label>;
                })}
                <label>الإجابة الصحيحة
                  <select disabled={busy} value={form.correctOption}
                    onChange={(e) => setForm((f) => ({ ...f, correctOption: e.target.value as AnswerKey }))}>
                    {(["A","B","C","D"] as AnswerKey[]).map((v) => <option key={v}>{v}</option>)}
                  </select>
                </label>
              </div>
              <div className="actions"><button className="primary" disabled={busy || !categories.length} type="submit">
                {editingId === null ? "إضافة السؤال" : "حفظ التعديلات"}</button>
              </div>
            </form>

            <h3>الأسئلة المحفوظة {data ? "(" + data.total + ")" : ""}</h3>
            <div className="editor-fields editor-filters">
              <label>بحث في السؤال أو المرجع
                <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="ابحث..." />
              </label>
              <label>المحور
                <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
                  <option value="">كل المحاور</option>
                  {categories.map((c) => <option key={c.key} value={c.key}>{c.internalName}</option>)}
                </select>
              </label>
              <label>الصعوبة
                <select value={difficulty} onChange={(e) => { setDifficulty(e.target.value); setPage(1); }}>
                  <option value="">كل المستويات</option>
                  {[1,2,3,4,5].map((n) => <option key={n} value={n}>{levels[n]}</option>)}
                </select>
              </label>
              <label>الحالة
                <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                  <option value="active">مفعلة</option>
                  <option value="inactive">معطلة</option>
                  <option value="all">الكل</option>
                </select>
              </label>
            </div>
            <div className="editor-results">
              {data?.items.length === 0 ? <p className="muted">لا توجد أسئلة مطابقة.</p> : null}
              {data?.items.map((item) => (
                <div className="editor-item" key={item.id}>
                  <div className="editor-item-body">
                    <strong>#{item.id} · {item.prompt}</strong>
                    <small>{categories.find((c) => c.key === item.categoryKey)?.internalName || item.categoryKey}
                      {" · "} {levels[item.difficulty]} {" · "}الإجابة: {item.correctOption}
                      {item.active ? "" : " · معطل"}</small>
                  </div>
                  <div className="actions">
                    <button type="button" disabled={busy} onClick={() => {
                      setEditingId(item.id);
                      setForm({ categoryKey:item.categoryKey,prompt:item.prompt,optionA:item.optionA,
                        optionB:item.optionB,optionC:item.optionC,optionD:item.optionD,
                        correctOption:item.correctOption,difficulty:item.difficulty,sourceRef:item.sourceRef });
                      clearAlerts(); window.scrollTo({top:0,behavior:"smooth"});
                    }}>تعديل</button>
                    <button type="button" disabled={busy} onClick={() => {
                      setEditingId(null); setForm({ categoryKey:item.categoryKey,
                        prompt:item.prompt + " (نسخة)",optionA:item.optionA,optionB:item.optionB,
                        optionC:item.optionC,optionD:item.optionD,correctOption:item.correctOption,
                        difficulty:item.difficulty,sourceRef:null });
                      setNotice("هذه نسخة جديدة، عدّل نصها ثم احفظها.");
                      window.scrollTo({top:0,behavior:"smooth"});
                    }}>نسخ</button>
                    <button type="button" disabled={busy}
                      onClick={() => void hideQuestion(item.id, Boolean(item.active))}>
                      {item.active ? "تعطيل" : "استعادة"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="actions">
              <button type="button" disabled={page === 1} onClick={() => setPage((n) => Math.max(1,n-1))}>السابق</button>
              <span>صفحة {page} من {Math.max(1, Math.ceil((data?.total ?? 0) / 25))}</span>
              <button type="button" disabled={!data || page * 25 >= data.total} onClick={() => setPage((n) => n+1)}>التالي</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
