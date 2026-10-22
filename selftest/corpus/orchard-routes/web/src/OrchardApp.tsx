import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { features, sectionPath } from './features';
import { OrchardLayout } from './layout/OrchardLayout';
import OrchardHome from './landing/OrchardHome';
import RowsLayout from './rows/RowsLayout';
import RowList from './rows/RowList';
import RowDetail from './rows/RowDetail';
import { HarvestRoutes } from './harvest/HarvestRoutes';
import PruningPlannerPage from './pruning/PruningPlannerPage';
import PruningLegacyPage from './pruning/PruningLegacyPage';
import { RequireCrew } from './access/RequireCrew';
import IrrigationPage from './irrigation/IrrigationPage';
import ReportViewer from './reports/ReportViewer';
import Mystery from './mystery/Mystery';
import { ShedRoutes } from './shed/ShedRoutes';
import { AnnexRoutes } from './annex/AnnexRoutes';
import CellarSettings from './cellar/CellarSettings';
import { DoubleSettings } from './double/DoubleSettings';
import { PressRoutes } from './pressing/PressRoutes';
import { QueueRoutes } from './queues/QueueRoutes';
import { SpareRoutes } from './spare/SpareRoutes';
import GatePost from './double/GatePost';
import { GreenhouseRoutes } from './greenhouse/GreenhouseRoutes';
import { LoftyRoutes } from './lofty/LoftyRoutes';
import { StorehouseRoutes } from './storehouse/StorehouseRoutes';

const gateEntries = [
  { path: '/gate', component: <GatePost /> },
];

export function OrchardApp() {
  return (
    <Routes>
      <Route path="/" element={<OrchardLayout />}>
        <Route index element={<OrchardHome />} />
        <Route path="rows" element={<RowsLayout />}>
          <Route index element={<RowList />} />
          <Route path=":rowId" element={<RowDetail />} />
        </Route>
        <Route path="/harvest/*" element={<HarvestRoutes />} />
        <Route path="old-rows" element={<Navigate to="/rows" replace />} />
        {features.pruningPlanner ? (
          <Route path="pruning" element={<PruningPlannerPage />} />
        ) : (
          <Route path="pruning" element={<PruningLegacyPage />} />
        )}
        <Route
          path="irrigation"
          element={
            <RequireCrew role="irrigator">
              <IrrigationPage />
            </RequireCrew>
          }
        />
        <Route path="reports/*" element={<ReportViewer />} />
        <Route path={sectionPath} element={<Mystery />} />
        <Route path="shed/*" element={<ShedRoutes />} />
        <Route path="pressing/*" element={<PressRoutes />} />
        <Route path="queues/*" element={<QueueRoutes />} />
        <Route path="cellar/*" element={<CellarSettings />} />
        <Route path="annex/*" element={<AnnexRoutes />} />
        <Route path="spare/*" element={<SpareRoutes />} />
        <Route path="double" element={<DoubleSettings entries={gateEntries} />} />
        <Route path="storehouse/*" element={<StorehouseRoutes />} />
        <Route path="greenhouse/*" element={<GreenhouseRoutes />} />
        <Route path="lofty/*" element={<LoftyRoutes />} />
      </Route>
    </Routes>
  );
}
