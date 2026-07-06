import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Canvas · Tako", description: "Spatial research canvas" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
