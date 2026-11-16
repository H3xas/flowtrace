import React from 'react';

interface ActionButtonProps {
  label: string;
  action: () => void;
}

export function ActionButton({ label, action }: ActionButtonProps) {
  return (
    <button type="button" onClick={action}>
      {label}
    </button>
  );
}
