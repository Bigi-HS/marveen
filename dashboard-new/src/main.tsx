import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Design tokens live outside src/ (single source of palette hex); imported here so
// the :root custom properties are available app-wide.
import '../styles/tokens.css'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
