import React from 'react';
import { Route, Routes } from 'react-router-dom';
import RegattaPage from './regatta/RegattaPage';
import ResultsBoard from './results/ResultsBoard';
import CrewRoster from './crews/CrewRoster';
import SignupPanel from './crews/SignupPanel';
import BoatList from './boats/BoatList';
import MarkBoard from './marks/MarkBoard';
import WindBox from './weather/WindBox';
import GroupShell from './groups/GroupShell';
import { Frame } from './layout/Frame';
import { Layout } from './layout/Layout';

export function App() {
  return (
    <Routes>
      <Route path="regattas/:regattaId" element={<RegattaPage />} />
      <Route path="results" element={<ResultsBoard />} />
      <Route path="crews/:crewId" element={<Layout main={<CrewRoster />} side={<SignupPanel />} />} />
      <Route path="boats" element={<Frame><BoatList /></Frame>} />
      <Route path="marks" element={<Layout main={<MarkBoard />} side={null} />} /><Route path="marks/:markId" element={<Layout main={<MarkBoard />} side={null} />} />
      <Route path="weather" element={<WindBox />} />
      <Route path="groups/:groupId/*" element={<GroupShell />} />
    </Routes>
  );
}
