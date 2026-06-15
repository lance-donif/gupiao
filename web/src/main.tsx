import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppShellProvider } from '@/app/app-context';
import { ToastProvider } from '@/components/ui/toast';
import App from './App';
import './styles.css';

const DashboardPage = lazy(() => import('./pages/Dashboard'));
const RecommendationHistoryPage = lazy(() => import('./pages/RecommendationHistory'));
const StrategiesPage = lazy(() => import('./pages/Strategies'));

function PageFallback() {
  return (
    <div className="flex h-[calc(100vh-48px)] items-center justify-center text-[12px] text-muted-foreground">
      加载中…
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<PageFallback />}>
            <DashboardPage />
          </Suspense>
        ),
      },
      {
        path: 'strategies',
        element: (
          <Suspense fallback={<PageFallback />}>
            <StrategiesPage />
          </Suspense>
        ),
      },
      {
        path: 'history',
        element: (
          <Suspense fallback={<PageFallback />}>
            <RecommendationHistoryPage />
          </Suspense>
        ),
      },
      { path: 'traces/:traceId', element: <Navigate to="/" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <AppShellProvider>
        <RouterProvider router={router} />
      </AppShellProvider>
    </ToastProvider>
  </React.StrictMode>,
);
