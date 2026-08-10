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

export const metadata: Metadata = {
  title: "Arte-Luta Brasil Competições",
  description: "Gestão completa de campeonatos e festivais de capoeira.",
  applicationName: "Arte-Luta Competições",
  manifest: "/manifest.webmanifest",
};
export const viewport: Viewport = { themeColor: "#171813", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
