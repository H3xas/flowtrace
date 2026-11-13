import React, { ReactNode } from 'react';

interface ShellProps {
  main: ReactNode;
  side: ReactNode;
}

export function Shell({ main, side }: ShellProps) {
  return (
    <div className="shell">
      <main>{main}</main>
      <aside>{side}</aside>
    </div>
  );
}
