import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function RowDetail() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/orchard/rows')}>
      All rows
    </button>
  );
}
