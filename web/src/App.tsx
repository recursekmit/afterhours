/*
  Four surfaces, one bundle: attendee (/), console (/admin), projector (/screen), shopkeeper (/stall).
  Console, projector and stall are lazy so phones never download them.
*/
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { LoadingState } from './kit';
import { AttendeeApp } from './surfaces/attendee/AttendeeApp';

const AdminApp = lazy(() => import('./surfaces/admin/AdminApp'));
const ScreenApp = lazy(() => import('./surfaces/screen/ScreenApp'));
const StallApp = lazy(() => import('./surfaces/stall/StallApp'));
const KitPage = lazy(() => import('./dev/KitPage'));
const SlipsPage = lazy(() => import('./dev/slips/SlipsPage'));

export function App() {
  return (
    <Suspense fallback={<LoadingState label="loading..." />}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/screen/*" element={<ScreenApp />} />
        <Route path="/stall" element={<StallApp />} />
        <Route path="/stall/r/:token" element={<StallApp />} />
        <Route path="/dev/kit" element={<KitPage />} />
        <Route path="/dev/slips" element={<SlipsPage />} />
        <Route path="/*" element={<AttendeeApp />} />
      </Routes>
    </Suspense>
  );
}
