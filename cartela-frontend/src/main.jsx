import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import CartelaMiniApp from './CartelaMiniApp'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CartelaMiniApp />
  </StrictMode>,
)
