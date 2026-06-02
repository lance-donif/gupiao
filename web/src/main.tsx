import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppShellProvider } from '@/app/app-context';
import { ToastProvider } from '@/components/ui/toast';
import App from './App';
import DashboardPage from './pages/Dashboard';
import RecommendationHistoryPage from './pages/RecommendationHistory';
import StrategiesPage from './pages/Strategies';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'strategies', element: <StrategiesPage /> },
      { path: 'history', element: <RecommendationHistoryPage /> },
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
