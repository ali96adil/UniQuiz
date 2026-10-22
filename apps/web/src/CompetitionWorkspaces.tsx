import { useEffect, useState } from "react";

export type ParticipantType = "college" | "department" | "class" | "team";
export const PARTICIPANT_LABELS: Record<ParticipantType, { singular: string; plural: string }> = {
  college: { singular: "كلية", plural: "الكليات" },
  department: { singular: "قسم", plural: "الأقسام" },
  class: { singular: "شعبة", plural: "الشعب" },
  team: { singular: "فريق", plural: "الفرق" },
};

interface Workspace {
  id: string;
  name: string;
  participantType: ParticipantType;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const result = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(result.message ?? result.error ?? String(response.status));
  return result;
}

export function CompetitionWorkspacesPanel({
  onActiveChange,
}: {
  onActiveChange: (type: ParticipantType) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ParticipantType>("college");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    const response = await api<{ competitions: Workspace[] }>("/api/competitions");
    setWorkspaces(response.competitions);
    const active = response.competitions.find((workspace) => workspace.active);
    if (active) onActiveChange(active.participantType);
  };
  useEffect(() => {
    void refresh().catch((caught) =>
      setError(caught instanceof Error ? caught.message : "تعذر قراءة المسابقات"),
    );
  }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      await refresh();
      setMessage(success);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "تعذر إكمال الإجراء");
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (!newName.trim()) return;
    void run(async () => {
      await api("/api/competitions", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), participantType: newType }),
      });
      setNewName("");
    }, "تم إنشاء مسابقة مستقلة. اختر «فتح المسابقة» حتى تبدأ إعدادها.");
  };

  const activate = (workspace: Workspace) => {
    if (workspace.active) return;
    if (!window.confirm(
      `فتح «${workspace.name}»؟ سيُحفظ تقدم المسابقة الحالية وتُؤخذ نسخة احتياطية، ولن يمكن التبديل أثناء جولة فعّالة.`,
    )) return;
    void run(async () => {
      await api("/api/competitions/" + encodeURIComponent(workspace.id) + "/activate", {
        method: "POST",
        body: "{}",
      });
      // Refresh client-side caches after the atomic SQLite switch.
      window.location.reload();
    }, "تم فتح المسابقة.");
  };

  const duplicate = (workspace: Workspace) => {
    const name = window.prompt("اسم النسخة الجديدة:", workspace.name + " — نسخة");
    if (!name?.trim()) return;
    void run(async () => {
      await api("/api/competitions/" + encodeURIComponent(workspace.id) + "/duplicate", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), participantType: workspace.participantType }),
      });
    }, "تم نسخ إعدادات المشاركين والهوية والمحاور فقط، دون القرعة أو النتائج.");
  };

  const rename = (workspace: Workspace) => {
    const name = window.prompt("اسم المسابقة الجديد:", workspace.name);
    if (!name?.trim()) return;
    const type = window.prompt(
      "نوع المتنافسين: college للكليات / department للأقسام / class للشعب / team للفرق",
      workspace.participantType,
    );
    if (type === null) return;
    if (!["college","department","class","team"].includes(type.trim())) {
      setError("نوع المتنافسين غير صحيح. استخدم college أو department أو class أو team.");
      return;
    }
    if (name.trim() === workspace.name && type.trim() === workspace.participantType) return;
    void run(async () => {
      await api("/api/competitions/" + encodeURIComponent(workspace.id), {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), participantType: type.trim() }),
      });
    }, "تم تعديل اسم المسابقة أو نوع المتنافسين دون تغيير نتائجها.");
  };

  const remove = (workspace: Workspace) => {
    if (workspace.active || workspace.id === "legacy") return;
    const typedName = window.prompt(
      `حذف «${workspace.name}» من قائمة المسابقات؟ سيتم إنشاء نسخة احتياطية كاملة أولاً، لكن بيانات هذه المسابقة ستختفي من القائمة. لا يُحذف الأرشيف المستقل أو بنك الأسئلة. لتأكيد الحذف اكتب اسم المسابقة كاملاً:`,
      "",
    );
    if (typedName === null) return;
    if (typedName !== workspace.name) {
      setError("الاسم غير مطابق، لم يحدث حذف.");
      return;
    }
    if (!window.confirm("تأكيد أخير: حذف هذه المسابقة غير النشطة بعد إنشاء Backup موثّق؟")) return;
    void run(async () => {
      await api("/api/competitions/" + encodeURIComponent(workspace.id), {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE_COMPETITION", name: typedName }),
      });
    }, "تم حذف المسابقة من القائمة بعد النسخة الاحتياطية. بقي الأرشيف وبنك الأسئلة محفوظين.");
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="step-label">M7 · Multi-competition</p>
          <h2>إدارة المسابقات</h2>
          <p className="muted">
            كل مسابقة تحتفظ بالمشاركين والقرعة والنتائج والهوية الخاصة بها.
            بنك الأسئلة مشترك بين جميع المسابقات.
          </p>
        </div>
      </div>
      <div className="audience-settings-grid">
        <label>
          <span>اسم المسابقة الجديدة</span>
          <input
            value={newName}
            maxLength={160}
            disabled={busy}
            placeholder="مثال: بطولة المعلومات الرياضية"
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <label>
          <span>نوع المتنافسين</span>
          <select
            value={newType}
            disabled={busy}
            onChange={(event) => setNewType(event.target.value as ParticipantType)}
          >
            <option value="college">كليات</option>
            <option value="department">أقسام</option>
            <option value="class">شعب</option>
            <option value="team">فرق</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy || !newName.trim()} onClick={create}>
          إنشاء مسابقة مستقلة
        </button>
      </div>

      <p className="muted">
        المسابقة المفتوحة لا يمكن حذفها؛ افتح مسابقة أخرى أولاً. 
        نسخة 2026 الأساسية (legacy) محمية دائماً.
        الحذف يتطلب كتابة الاسم، ويتبعه Backup موثّق، ولا يحذف الأرشيف أو بنك الأسئلة.
      </p>
      <div className="round-allocation-grid">
        {workspaces.map((workspace) => (
          <div className="round-allocation" key={workspace.id}>
            <strong>{workspace.name}</strong>
            <span>{PARTICIPANT_LABELS[workspace.participantType].plural}</span>
            <small>{workspace.active ? "المسابقة المفتوحة حالياً" : "محفوظة"}</small>
            <div className="actions">
              {workspace.active ? null : (
                <button className="primary" disabled={busy} onClick={() => activate(workspace)}>
                  فتح المسابقة
                </button>
              )}
              <button disabled={busy} onClick={() => rename(workspace)}>
                تعديل الاسم والنوع
              </button>
              <button disabled={busy} onClick={() => duplicate(workspace)}>
                نسخ الإعدادات
              </button>
              {!workspace.active && workspace.id !== "legacy" ? (
                <button className="danger-outline" disabled={busy} onClick={() => remove(workspace)}>
                  حذف المسابقة
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {error ? <p className="status-message error">{error}</p> : null}
      {message ? <p className="status-message success">{message}</p> : null}
    </section>
  );
}
