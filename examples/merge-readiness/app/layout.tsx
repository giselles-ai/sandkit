import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "Merge Readiness",
  description: "GitHub pull-request readiness investigations powered by Sandkit.",
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
