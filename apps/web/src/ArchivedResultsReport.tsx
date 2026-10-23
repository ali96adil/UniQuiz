import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AudienceDisplaySettings,
  QualificationRankingSnapshot,
} from "@uniquiz/shared";

type ParticipantType = "college" | "department" | "class" | "team";
interface ArchivedReport {
  archive: {
    title: string; archivedAt: string;
    participantCount: number; roundCount: number; questionCount: number;
  };
  participantType: ParticipantType | null;
  snapshot: {
    ranking: QualificationRankingSnapshot;
    audienceSettings: AudienceDisplaySettings;
  };
}

const participantLabels: Record<ParticipantType, { singular: string; plural: string }> = {
  college: { singular: "كلية", plural: "الكليات" },
  department: { singular: "قسم", plural: "الأقسام" },
  class: { singular: "شعبة", plural: "الشعب" },
  team: { singular: "فريق", plural: "الفرق" },
};

/** This A4 report always reads the stored archive, never /api/ranking or the
 * currently active workspace. It shares the official report's print CSS. */
export function ArchivedResultsReport() {
  const id = window.location.pathname.match(/^\/archives\/([^/]+)\/report\/?$/)?.[1];
  const autoPrint = useMemo(() =>
    new URLSearchParams(window.location.search).get("print") === "1", []);
  const autoPrintStarted = useRef(false);
  const [data, setData] = useState<ArchivedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuedAt] = useState(() => new Date());

  useEffect(() => {
    document.title = "بيان نتائج الأرشيف - مسابقة بنك المعلومات";
    if (!id) { setError("رابط الأرشيف غير صالح."); return; }
    const controller = new AbortController();
    void fetch("/api/archives/" + encodeURIComponent(id), {
      signal: controller.signal, cache: "no-store", credentials: "same-origin",
    }).then(async (response) => {
      if (!response.ok) throw new Error("تعذّر قراءة نتائج هذا الأرشيف (" + response.status + ").");
      return response.json() as Promise<ArchivedReport>;
    }).then(setData).catch((reason) => {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "تعذّر فتح الأرشيف.");
    });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!data || !autoPrint || autoPrintStarted.current) return;
    autoPrintStarted.current = true;
    let cancelled = false;
    const printWhenReady = async () => {
      // Images and Arabic web fonts must finish before browser PDF capture.
      const images = Array.from(document.images);
      await Promise.all(images.map(async image => {
        if (!image.complete) {
          await new Promise<void>(resolve => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          });
        }
        try { await image.decode(); } catch { /* optional logo */ }
      }));
      try { await document.fonts.ready; } catch { /* system Arabic font */ }
      await new Promise<void>(resolve => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      });
      await new Promise<void>(resolve => window.setTimeout(resolve, 500));
      if (!cancelled) { window.focus(); window.print(); }
    };
    void printWhenReady();
    return () => { cancelled = true; };
  }, [autoPrint, data]);

  if (error) return <section className="official-report report-loading" dir="rtl">
    <strong>{error}</strong><a href="/archives">العودة إلى الأرشيف</a>
  </section>;
  if (!data || !id) return <section className="official-report report-loading" dir="rtl">
    <strong>جاري تجهيز بيان النتائج من الأرشيف...</strong>
  </section>;

  const { archive, participantType, snapshot } = data;
  const { ranking, audienceSettings: settings } = snapshot;
  const entries = ranking.entries;
  const topThree = entries.filter(item => item.rank !== null).slice(0, 3);
  const plural = participantType ? participantLabels[participantType].plural : "المشاركين";
  const singular = participantType ? participantLabels[participantType].singular : "المشارك";
  const issuedLabel = new Intl.DateTimeFormat("ar-IQ", {
    dateStyle: "full", timeStyle: "short",
  }).format(issuedAt);
  const archiveDate = new Intl.DateTimeFormat("ar-IQ", {
    dateStyle: "full", timeStyle: "short",
  }).format(new Date(archive.archivedAt));
  const logoBase = "/api/archives/" + encodeURIComponent(id) + "/assets/";

  return <section className="official-report" dir="rtl">
    <div className="report-toolbar">
      <a className="button-link" href="/archives">العودة إلى الأرشيف</a>
      <button className="primary" onClick={() => window.print()}>طباعة / حفظ PDF</button>
    </div>
    <header className="report-letterhead">
      <div className="report-logo">
        {settings.universityLogoUrl ? <img src={logoBase + "university"} alt="شعار الجامعة المحفوظ" /> : null}
      </div>
      <div className="report-heading">
        <h1>{archive.title}</h1>
        {settings.eventSubtitle ? <p>{settings.eventSubtitle}</p> : null}
        <h2>بيان النتائج الرسمي — الأرشيف</h2>
      </div>
      <div className="report-logo">
        {settings.departmentLogoUrl ? <img src={logoBase + "department"} alt="شعار القسم المحفوظ" /> : null}
      </div>
    </header>
    <div className="report-patronage">
      <strong>{settings.copy.patronageLine}</strong>
      <strong>{settings.copy.supervisionLine}</strong>
    </div>
    <div className="report-meta">
      <span><b>عدد {plural}:</b> {archive.participantCount}</span>
      <span><b>تاريخ حفظ البطولة:</b> {archiveDate}</span>
      <span><b>تاريخ إصدار البيان:</b> {issuedLabel}</span>
      <span><b>الجولات والأسئلة:</b> {archive.roundCount} جولة · {archive.questionCount} سؤال</span>
      {settings.venue ? <span><b>المكان:</b> {settings.venue}</span> : null}
      {settings.season ? <span><b>الموسم:</b> {settings.season}</span> : null}
    </div>
    <section className="report-top-three">
      {topThree.map(entry => <article key={entry.college.id}
        className={"report-podium-card" + (entry.rank === 1 ? " first" : "")}>
        <span>المركز {entry.rank}</span>
        <strong>{entry.college.name}</strong>
        <b>{entry.scorePoints} نقطة</b>
        <small>مجموع زمن الإجابات: {(entry.totalResponseTimeMs / 1000).toFixed(3)} ثانية</small>
      </article>)}
    </section>
    <h3 className="report-table-title">{settings.copy.finalRankingTitle}</h3>
    <table className="official-results-table">
      <thead><tr>
        <th>المركز</th><th>{singular}</th><th>المجموع</th>
        <th>مجموع زمن الإجابات</th><th>الإجابات الصحيحة</th><th>الإجابات الخاطئة</th>
      </tr></thead>
      <tbody>{entries.map(entry => <tr key={entry.college.id}
        className={(entry.rank ?? 99) <= 3 ? "report-top-row" : undefined}>
        <td>{entry.rank ?? "—"}</td>
        <td>{entry.college.name}</td>
        <td>{entry.scorePoints} نقطة</td>
        <td>{(entry.totalResponseTimeMs / 1000).toFixed(3)} ثانية</td>
        <td>{entry.correctAnswers}</td>
        <td>{entry.wrongAnswers}</td>
      </tr>)}</tbody>
    </table>
    <footer className="report-footer">
      <span>تم إصدار هذا البيان اعتماداً على نتائج البطولة المحفوظة في الأرشيف، ولا يتأثر بالمسابقات الجديدة.</span>
      <span>{settings.footerText}</span>
    </footer>
  </section>;
}
