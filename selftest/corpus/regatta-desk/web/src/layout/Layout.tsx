import React, { ReactNode } from 'react';

interface LayoutProps {
  main: ReactNode;
  side: ReactNode;
}

export function Layout({ main, side }: LayoutProps) {
  return (
    <div className="layout">
      <main>{main}</main>
      <aside>{side}</aside>
    </div>
  );
}
