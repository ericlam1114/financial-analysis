import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/theme-provider'; // Assuming a ThemeProvider component
import { Header } from '@/components/Header'; // Import the header

const inter = Inter({ subsets: ['latin'] });

export const metadata = {
  title: 'Valuations AI',
  description: 'AI-powered music catalog valuations',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen flex flex-col`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Header /> {/* Add Header here */}
          <div className="flex-grow">
            {children}
          </div>
          {/* Footer could go here */}
        </ThemeProvider>
      </body>
    </html>
  );
} 