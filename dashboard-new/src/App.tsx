import { useState } from 'react'
import { NavShell, type TabKey } from '@/components/NavShell'
import { Home } from '@/pages/Home'
import { KanbanPage } from '@/pages/KanbanPage'
import { GateBoardPage } from '@/pages/GateBoardPage'
import { CostBoardPage } from '@/pages/CostBoardPage'
import { HookStreamPage } from '@/pages/HookStreamPage'
import { UsagePage } from '@/pages/UsagePage'
import { AppHome } from '@/pages/app/AppHome'
import { WorkoutScreen } from '@/pages/app/WorkoutScreen'
import { ClaudiaTodosScreen } from '@/pages/app/ClaudiaTodosScreen'
import { GelimJournalScreen } from '@/pages/app/GelimJournalScreen'
import { MobileSetup } from '@/pages/app/MobileSetup'
import { FlottaScreen } from '@/pages/app/FlottaScreen'
import { OfficeScreen } from '@/pages/app/OfficeScreen'
import { PushSettingsScreen } from '@/pages/app/PushSettingsScreen'
import { ShowcaseScreen } from '@/pages/app/ShowcaseScreen'
import { RPGScreen } from '@/pages/app/RPGScreen'
import { TwelveWeekYearScreen } from '@/pages/app/TwelveWeekYearScreen'
import { LongTermTodoScreen } from '@/pages/app/LongTermTodoScreen'

// In Tauri, default to the App tab for the mobile-first experience.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const DEFAULT_TAB: TabKey = isTauri ? 'app-home' : 'home'

export default function App() {
  const [tab, setTab] = useState<TabKey>(DEFAULT_TAB)
  return (
    <NavShell active={tab} onSelect={setTab}>
      {tab === 'home' && <Home />}
      {tab === 'kanban' && <KanbanPage />}
      {tab === 'gate' && <GateBoardPage />}
      {tab === 'cost' && <CostBoardPage />}
      {tab === 'hooks' && <HookStreamPage />}
      {tab === 'usage' && <UsagePage />}
      {tab === 'app-home' && <AppHome />}
      {tab === 'workout' && <WorkoutScreen />}
      {tab === 'todos' && <ClaudiaTodosScreen />}
      {tab === 'journal' && <GelimJournalScreen />}
      {tab === 'app-setup' && <MobileSetup />}
      {tab === 'fleet' && <FlottaScreen />}
      {tab === 'office' && <OfficeScreen />}
      {tab === 'push-settings' && <PushSettingsScreen />}
      {tab === 'showcase' && <ShowcaseScreen />}
      {tab === 'rpg' && <RPGScreen />}
      {tab === 'twelveweekyear' && <TwelveWeekYearScreen />}
      {tab === 'longtermtodos' && <LongTermTodoScreen />}
    </NavShell>
  )
}
