import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./login.css";
import "./management.css";
import "./event-detail.css";
import "./auth-extra.css";
import "./participants.css";
import "./dashboard.css";
import "./operations.css";
import "./judges.css";
import "./judge-applications.css";
import "./results.css";
import "./matches.css";
import "./judge-voting.css";
import "./vote-monitor.css";
import "./public-display.css";
import "./public-display-musicality.css";
import "./checkin.css";
import "./event-settings.css";
import "./settings-help.css";
import "./csv-import.css";
import "./users.css";
import "./account-menu.css";
import "./brand-theme.css";
import "./production-layout.css";
import "./brand-system.css";
import "./responsive-system.css";
import "./responsive-experience.css";

export const metadata: Metadata = {
  title: "Arena Arte Luta",
  description: "Gestão profissional de campeonatos, avaliações e resultados.",
  applicationName: "Arena Arte Luta",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/brand/capoeira-app-icon-v2.png", type: "image/png", sizes: "512x512" }],
    shortcut: [{ url: "/brand/capoeira-app-icon-v2.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/brand/capoeira-app-icon-v2.png", type: "image/png", sizes: "512x512" }],
  },
};
export const viewport: Viewport = { themeColor: "#11140f", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
