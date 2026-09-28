import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type {
  ClientRole,
  PresenceSnapshot,
  StationPresence,
} from "@uniquiz/shared";

const routeTitles: Record<ClientRole, string> = {
  operator: "لوحة التحكم",
  display: "شاشة الجمهور",
  "team-a": "محطة المتسابق A",
  "team-b": "محطة المتسابق B",
  unknown: "UniQuiz",
};

function roleFromPath(pathname: string): ClientRole {
  if (pathname.startsWith("/operator")) return "operator";
  if (pathname.startsWith("/display")) return "display";
  if (pathname.startsWith("/team/a")) return "team-a";
  if (pathname.startsWith("/team/b")) return "team-b";
  return "unknown";
}

function PresenceCard({ station }: { station: StationPresence }) {
  return (
    <div className="presence-card">
      <span>{routeTitles[station.role]}</span>
      <strong className={station.connected ? "online" : "offline"}>
        {station.connected ? `متصل (${station.connections})` : "غير متصل"}
      </strong>
    </div>
  );
}

export function App() {
  const role = useMemo(() => roleFromPath(window.location.pathname), []);
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);

  useEffect(() => {
    const socket = io({
      auth: { role },
    });

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("presence:snapshot", (snapshot: PresenceSnapshot) => {
      setPresence(snapshot);
    });

    return () => {
      socket.disconnect();
    };
  }, [role]);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">University Knowledge Competition</p>
        <h1>{routeTitles[role]}</h1>
        <p className="subtitle">
          M1 — Local Runtime / Realtime Connectivity
        </p>
        <div className="connection">
          <span className={connected ? "dot online-bg" : "dot offline-bg"} />
          {connected ? "متصل بالسيرفر" : "جاري الاتصال بالسيرفر"}
        </div>
      </section>

      {role === "operator" ? (
        <section className="panel">
          <h2>حالة المحطات</h2>
          <div className="presence-grid">
            {presence?.stations.map((station) => (
              <PresenceCard key={station.role} station={station} />
            )) ?? <p>بانتظار أول تحديث...</p>}
          </div>
        </section>
      ) : (
        <section className="panel">
          <h2>جاهز للمرحلة التالية</h2>
          <p>
            هذه واجهة M1 المؤقتة. ستتبدل تلقائياً بدون Refresh عند إضافة
            حالات المسابقة.
          </p>
        </section>
      )}
    </main>
  );
}
