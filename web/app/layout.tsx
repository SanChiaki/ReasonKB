import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReasonKB",
  description: "按项目组织的知识对话工作区",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
