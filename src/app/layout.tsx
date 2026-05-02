import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Contribution Checker",
  description: "Gate PRs behind a contributor application form.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
