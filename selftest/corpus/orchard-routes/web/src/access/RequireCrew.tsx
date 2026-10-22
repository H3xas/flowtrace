import React, { ReactNode } from 'react';

export function RequireCrew({ role, children }: { role: string; children: ReactNode }) {
  return <div data-role={role}>{children}</div>;
}
