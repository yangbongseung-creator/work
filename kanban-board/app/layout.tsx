import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: '칸반 업무 보드' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* 저장된 테마를 화면이 그려지기 전에 적용해 깜빡임을 막는다 */}
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var t=localStorage.getItem('kanban:theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
