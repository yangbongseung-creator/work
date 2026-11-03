import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: '칸반 업무 보드' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
