import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "Sandkit GitHub Triage",
  description: "Durable SaaS-style triage workflow example with runCommand() and workspace reuse.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="grain" />
        <main className="page-root">{children}</main>
      </body>
    </html>
  );
}
