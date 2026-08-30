import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Whiteboard — Real-Time Collaborative Canvas',
  description: 'Create, collaborate, and communicate on a shared canvas in real time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
