import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Dashboard from './Dashboard.tsx'
import Settings from './Settings.tsx'

// All windows load the same bundle; the hash picks the view (see
// electron/main.ts createDashboardWindow / createSettingsWindow).
const route = window.location.hash.replace(/^#\/?/, '')
const view = route === 'dashboard' ? <Dashboard /> : route === 'settings' ? <Settings /> : <App />

createRoot(document.getElementById('root')!).render(<StrictMode>{view}</StrictMode>)
