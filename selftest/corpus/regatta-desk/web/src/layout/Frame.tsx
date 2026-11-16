import React, { ReactNode } from 'react';

export function Frame({ children }: { children: ReactNode }) {
  return <div className="frame">{children}</div>;
}
