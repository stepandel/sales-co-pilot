import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Dashboard from './Dashboard.tsx'

// Both windows load the same bundle; the dashboard window is opened
// with a #dashboard hash (see electron/main.ts createDashboardWindow).
const isDashboard = window.location.hash.replace(/^#\/?/, '') === 'dashboard'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDashboard ? <Dashboard /> : <App />}</StrictMode>,
)
