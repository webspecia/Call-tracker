import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Call Tracker CRM Web Panel',
  description: 'Real-time call tracking dashboard and webhook receiver management',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased bg-slate-950 text-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}
