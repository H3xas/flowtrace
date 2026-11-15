import React from 'react';
import { Route, Routes } from 'react-router-dom';
import GlanceCard from './GlanceCard';

export default function GroupGlance() {
  return (
    <Routes>
      <Route path="groups/:groupId" element={<GlanceCard />} />
    </Routes>
  );
}
