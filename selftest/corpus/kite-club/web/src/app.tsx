import React from 'react';
import { Route, Routes } from 'react-router-dom';
import JoinPage from './join/JoinPage';
import { Shell } from './layout/Shell';
import ClubFeed from './clubs/ClubFeed';
import ClubSidebar from './clubs/ClubSidebar';

export function App() {
  return (
    <Routes>
      <Route path="join" element={<JoinPage />} />
      <Route path="clubs/:clubId/*" element={<Shell main={<ClubFeed />} side={<ClubSidebar />} />} />
    </Routes>
  );
}
