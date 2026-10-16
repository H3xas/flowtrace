import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { features } from '../features';
import FermentList from './FermentList';
import PressArchive from './PressArchive';
import PressBench from './PressBench';
import { PressingNav } from './PressingNav';
import TankGauge from './TankGauge';
import TankProbe from './TankProbe';

const archiveEntry = {
  path: '/press-archive',
  title: 'Archive',
  component: <PressArchive />,
  isEnabled: features.pressArchive,
};

const entries = [
  { path: '/ferment', title: 'Ferment', component: <FermentList />, isEnabled: features.ferment },
  { path: '/press-bench', title: 'Bench', component: <PressBench />, isEnabled: true },
  { ...archiveEntry },
  { path: '/tank', title: 'Gauge', component: <TankGauge />, isEnabled: features.tankGauge },
  { path: '/tank', title: 'Probe', component: <TankProbe />, isEnabled: features.tankProbe },
];

const sidebarLinks = [
  { path: '/journal', label: 'Journal' },
];

export function PressRoutes() {
  return (
    <Routes>
      {entries
        .filter((entry) => entry.isEnabled)
        .map((entry) => (
          <Route path={entry.path} element={entry.component} key={entry.path} />
        ))}
      {sidebarLinks.map((link) => (
        <PressingNav key={link.path} to={link.path} label={link.label} />
      ))}
    </Routes>
  );
}
