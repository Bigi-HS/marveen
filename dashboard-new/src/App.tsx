import { useState } from 'react'
import { NavShell, type TabKey } from '@/components/NavShell'
import { Home } from '@/pages/Home'
import { KanbanPage } from '@/pages/KanbanPage'
import { GateBoardPage } from '@/pages/GateBoardPage'

export default function App() {
  const [tab, setTab] = useState<TabKey>('home')
  return (
    <NavShell active={tab} onSelect={setTab}>
      {tab === 'home' && <Home />}
      {tab === 'kanban' && <KanbanPage />}
      {tab === 'gate' && <GateBoardPage />}
    </NavShell>
  )
}
