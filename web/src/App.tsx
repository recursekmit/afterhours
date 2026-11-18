/*
  Three surfaces, one bundle: attendee (/), console (/admin), projector (/screen).
  Console and projector are lazy so phones never download them.
*/
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { LoadingState } from './kit';
import { AttendeeApp } from './surfaces/attendee/AttendeeApp';

const AdminApp = lazy(() => import('./surfaces/admin/AdminApp'));
const ScreenApp = lazy(() => import('./surfaces/screen/ScreenApp'));
const KitPage = lazy(() => import('./dev/KitPage'));
const SlipsPage = lazy(() => import('./dev/slips/SlipsPage'));

export function App() {
  return (
    <Suspense fallback={<LoadingState label="loading..." />}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
        <Route path="/screen/*" element={<ScreenApp />} />
        <Route path="/dev/kit" element={<KitPage />} />
        <Route path="/dev/slips" element={<SlipsPage />} />
        <Route path="/*" element={<AttendeeApp />} />
      </Routes>
    </Suspense>
  );
}
