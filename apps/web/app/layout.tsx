import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QalaHub',
  description: 'Городской сервис автоматического подбора доступных исполнителей',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
