import Link from 'next/link';

export function Header() {
  return (
    <header className="border-b mb-4">
      <nav className="container mx-auto flex items-center justify-between p-4">
        <Link href="/" className="text-xl font-semibold text-primary hover:text-primary/80">
          Valuations AI
        </Link>
        <div className="space-x-4">
          {/* <Link href="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Analysis Chat
          </Link>
          <Link href="/upload" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            Upload Documents
          </Link> */}
        </div>
      </nav>
    </header>
  );
} 