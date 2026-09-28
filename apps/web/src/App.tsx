import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type {
  ClientRole,
  PresenceSnapshot,
  StationPresence,
} from "@uniquiz/shared";

type Surface =
  | "home"
  | "setup"
  | "draw"
  | "operator"
  | "display"
  | "team-a"
  | "team-b";

const surfaceTitles: Record<Surface, string> = {
  home: "مسابقة بنك المعلومات",
  setup: "إعداد المسابقة",
  draw: "القرعة",
  operator: "لوحة التحكم",
  display: "شاشة الجمهور",
  "team-a": "محطة المتسابق A",
  "team-b": "محطة المتسابق B",
};

const roleTitles: Record<ClientRole, string> = {
  operator: "Operator",
  display: "Display",
  "team-a": "Team A",
  "team-b": "Team B",
  unknown: "Unknown",
};

function surfaceFromPath(pathname: string): Surface {
  if (pathname.startsWith("/setup")) return "setup";
  if (pathname.startsWith("/draw")) return "draw";
  if (pathname.startsWith("/operator")) return "operator";
  if (pathname.startsWith("/display")) return "display";
  if (pathname.startsWith("/team/a")) return "team-a";
  if (pathname.startsWith("/team/b")) return "team-b";
  return "home";
}

function roleForSurface(surface: Surface): ClientRole {
  switch (surface) {
    case "setup":
    case "draw":
    case "operator":
      return "operator";
    case "display":
      return "display";
    case "team-a":
      return "team-a";
    case "team-b":
      return "team-b";
    default:
      return "unknown";
  }
}

function PresenceCard({ station }: { station: StationPresence }) {
  return (
    <div className="presence-card">
      <span>{roleTitles[station.role]}</span>
      <strong className={station.connected ? "online" : "offline"}>
        {station.connected ? `متصل (${station.connections})` : "غير متصل"}
      </strong>
    </div>
  );
}

export function App() {
  const surface = useMemo(() => surfaceFromPath(window.location.pathname), []);
  const role = useMemo(() => roleForSurface(surface), [surface]);
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

  const showPresence =
    surface === "operator" || surface === "setup" || surface === "draw";

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">University Knowledge Competition</p>
        <h1>{surfaceTitles[surface]}</h1>
        <p className="subtitle">
          M1 — Local Runtime / Realtime Connectivity
        </p>
        <div className="connection">
          <span className={connected ? "dot online-bg" : "dot offline-bg"} />
          {connected ? "متصل بالسيرفر" : "جاري الاتصال بالسيرفر"}
        </div>
      </section>

      {showPresence ? (
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
