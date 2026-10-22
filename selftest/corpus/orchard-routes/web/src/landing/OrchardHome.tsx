import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function OrchardHome() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/orchard/harvest/crates')}>
      Crates
    </button>
  );
}
