import { useState } from "react";

export function OperatorLogin({ onLogin }: { onLogin: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const result = await response.json() as { authenticated?: boolean; error?: string };
      if (!response.ok || !result.authenticated) {
        throw new Error(result.error === "LOGIN_TEMPORARILY_LIMITED"
          ? "محاولات كثيرة؛ حاول بعد عشر دقائق."
          : "رمز المشغّل غير صحيح.");
      }
      setPassphrase("");
      onLogin();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر تسجيل الدخول.");
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="shell" dir="rtl">
      <section className="panel" style={{ maxWidth: 520, margin: "8vh auto" }}>
        <p className="eyebrow">UniQuiz · Operator Access</p>
        <h1>دخول مشغّل المسابقة</h1>
        <p className="muted">
          الإعدادات والقرعة والنتائج تحتاج صلاحية مشغّل.
          محطات المتسابقين وشاشة الجمهور تعمل بصورة مستقلة.
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>رمز دخول المشغّل</span>
            <input
              type="password"
              autoComplete="current-password"
              value={passphrase}
              required
              minLength={1}
              maxLength={1024}
              disabled={pending}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <div className="actions">
            <button className="primary" type="submit" disabled={pending || !passphrase}>
              {pending ? "جاري التحقق..." : "دخول"}
            </button>
          </div>
        </form>
        {error ? <p className="status-message error" role="alert">{error}</p> : null}
        <p className="muted">إذا نسيت الرمز، مدير النظام يقدر يغيّره بأمان من إعدادات تشغيل السيرفر.</p>
      </section>
    </main>
  );
}
