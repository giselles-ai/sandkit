import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "Sandkit OpenClaw Control Plane",
  description: "Production-oriented OpenClaw control plane using Sandkit sessions.",
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
