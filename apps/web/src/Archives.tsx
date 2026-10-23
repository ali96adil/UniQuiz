import { useEffect, useState } from "react";
import type {
  AudienceDisplaySettings,
  CompetitionSetupSnapshot,
  QualificationRankingSnapshot,
  QuestionBankSummary,
} from "@uniquiz/shared";

interface CompetitionArchive {
  id: string;
  title: string;
  archivedAt: string;
  participantCount: number;
  roundCount: number;
  questionCount: number;
}

interface ArchiveDetail {
  archive: CompetitionArchive;
  snapshot: {
    competition: CompetitionSetupSnapshot;
    ranking: QualificationRankingSnapshot;
    audienceSettings: AudienceDisplaySettings;
    questionBank: QuestionBankSummary;
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(data.message ?? data.error ?? "HTTP " + response.status);
  return data;
}

export function ArchivesPanel() {
  const [archives, setArchives] = useState<CompetitionArchive[]>([]);
  const [details, setDetails] = useState<ArchiveDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const result = await requestJson<{ archives: CompetitionArchive[] }>("/api/archives");
    setArchives(result.archives);
  };

  useEffect(() => {
    void refresh().catch((caught) =>
      setError(caught instanceof Error ? caught.message : "تعذر قراءة الأرشيف"),
    );
  }, []);

  const createArchive = async () => {
    const title = window.prompt("اسم المسابقة التي تريد حفظها:");
    if (!title?.trim()) return;
    if (!window.confirm("حفظ نسخة مستقلة من المسابقة الحالية؟ هذا لا يحذف أو يغير أي بيانات.")) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await requestJson<{ archive: CompetitionArchive }>("/api/archives", {
        method: "POST",
        body: JSON.stringify({ title: title.trim() }),
      });
      await refresh();
      setDetails(await requestJson<ArchiveDetail>("/api/archives/" + result.archive.id));
      setMessage("تم حفظ المسابقة في الأرشيف. نتائجها وأسئلتها محفوظة بنسخة تاريخية مستقلة.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر حفظ المسابقة");
    } finally {
      setBusy(false);
    }
  };

  const renameArchive = async (archive: CompetitionArchive) => {
    const title = window.prompt("العنوان الجديد في الأرشيف (لا يغيّر النقاط أو ترتيب الفائزين):", archive.title);
    if (!title?.trim() || title.trim() === archive.title) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await requestJson("/api/archives/" + encodeURIComponent(archive.id), {
        method: "PATCH", body: JSON.stringify({ title: title.trim() }),
      });
      await refresh();
      setDetails(existing => existing?.archive.id === archive.id
        ? { ...existing, archive: { ...existing.archive, title: title.trim() } }
        : existing);
      setMessage("تم تعديل عنوان الأرشيف فقط، وبقيت النتائج محفوظة دون تغيير.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر تعديل العنوان"); }
    finally { setBusy(false); }
  };

  const deleteArchive = async (archive: CompetitionArchive) => {
    const entered = window.prompt(
      `حذف الأرشيف التاريخي «${archive.title}»؟ نتائج هذا السجل وصوره وأسئلته ستزال من الأرشيف. نزّل نسخة JSON أولاً للاحتفاظ بها. لتأكيد الحذف اكتب العنوان كاملاً:`,
      "",
    );
    if (entered === null) return;
    if (entered !== archive.title) { setError("العنوان غير مطابق؛ لم يُحذف شيء."); return; }
    if (!window.confirm("تأكيد نهائي: حذف هذا الأرشيف بعد إنشاء نسخة احتياطية موثّقة للقاعدة؟")) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await requestJson("/api/archives/" + encodeURIComponent(archive.id), {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE_ARCHIVE", title: entered }),
      });
      setDetails(existing => existing?.archive.id === archive.id ? null : existing);
      await refresh();
      setMessage("تم حذف الأرشيف بعد أخذ Backup موثّق. بقي بنك الأسئلة والمسابقات كما هما.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "تعذر حذف الأرشيف"); }
    finally { setBusy(false); }
  };

  const openArchive = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setDetails(await requestJson<ArchiveDetail>("/api/archives/" + id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر فتح المسابقة");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>أرشيف المسابقات</h2>
          <p className="muted">لقطات تاريخية مستقلة عن المسابقة الحالية وبنك الأسئلة.</p>
        </div>
        <button className="primary" disabled={busy} onClick={() => void createArchive()}>
          حفظ المسابقة الحالية
        </button>
      </div>
      {error ? <div className="status-message error">{error}</div> : null}
      {message ? <div className="status-message success">{message}</div> : null}
      <p className="muted">يمكن تغيير عنوان الأرشيف أو حذفه بتأكيد مضاعف وBackup. لا يمكن تعديل النقاط أو الإجابات التاريخية داخل الأرشيف.</p>
      {archives.length === 0 ? (
        <p className="muted">لا توجد مسابقات محفوظة بعد.</p>
      ) : (
        <div className="category-counts">
          {archives.map((archive) => (
            <div className="panel" key={archive.id}>
              <h3>{archive.title}</h3>
              <p className="muted">
                {new Date(archive.archivedAt).toLocaleString("ar-IQ")} ·
                {archive.participantCount} مشارك ·
                {archive.roundCount} جولة ·
                {archive.questionCount} سؤال
              </p>
              <div className="actions">
                <button disabled={busy} onClick={() => void openArchive(archive.id)}>
                  عرض النتائج
                </button>
                <a className="button-link primary" href={"/archives/" + encodeURIComponent(archive.id) + "/report?print=1"} target="_blank" rel="noopener noreferrer">
                  تصدير النتائج PDF
                </a>
                <a className="button-link" href={"/api/archives/" + archive.id + "/export"} download>
                  نسخة احتياطية JSON
                </a>
                <button disabled={busy} onClick={() => void renameArchive(archive)}>تعديل العنوان</button>
                <button className="danger-outline" disabled={busy} onClick={() => void deleteArchive(archive)}>
                  حذف الأرشيف
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {details ? (
        <div className="panel">
          <h3>{details.archive.title} — الترتيب المحفوظ</h3>
          <p className="muted">هذا التقرير يقرأ نسخة تاريخية ولا يغير البيانات الحالية.</p>
          <table>
            <thead>
              <tr>
                <th>الترتيب</th><th>المشارك</th><th>النقاط</th>
                <th>الصحيحة</th><th>الخاطئة</th>
              </tr>
            </thead>
            <tbody>
              {details.snapshot.ranking.entries.map((entry) => (
                <tr key={entry.college.id}>
                  <td>{entry.rank ?? "—"}</td>
                  <td>{entry.college.name}</td>
                  <td>{entry.scorePoints}</td>
                  <td>{entry.correctAnswers}</td>
                  <td>{entry.wrongAnswers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
