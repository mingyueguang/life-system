import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "人生系统",
  description: "目标、财务、健康与会员资源管理。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
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
