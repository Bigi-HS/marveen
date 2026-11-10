import { apiGet, getToken, buildAuthHeaders, ApiError } from './api'

export interface WorkoutExercise {
  name: string
  sets: number | null
  reps: number | null
  weight: number | null
  unit: string | null
}

export interface WorkoutPlan {
  date: string
  exercises: WorkoutExercise[]
  notes: string | null
}

export interface AppCalendarEvent {
  id: string
  summary: string
  start: string
  end: string
  location: string | null
  description: string | null
}

export interface TodoItem {
  id: string
  title: string
  detail: string | null
  kind: string | null
  status: string | null
  done: number
  created_at: number
}

export interface ClaudiaTodosResponse {
  today: TodoItem[]
  carried: TodoItem[]
  folyamatban: TodoItem[]
  doneToday: TodoItem[]
  capCount: number
}

export interface JournalEntry {
  id: number
  content: string
  mood: string | null
  tags: string | null
  createdAt: number
}

export async function fetchWorkoutPlan(): Promise<WorkoutPlan | null> {
  try {
    return await apiGet<WorkoutPlan>('/api/workout/plan')
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return null
    throw err
  }
}

export async function fetchCalendarToday(): Promise<AppCalendarEvent[]> {
  try {
    const res = await apiGet<{ events: AppCalendarEvent[] }>('/api/calendar/today')
    return res.events ?? []
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) return []
    throw err
  }
}

export async function fetchJournalEntries(limit = 5): Promise<JournalEntry[]> {
  const res = await apiGet<{ entries: JournalEntry[] }>(`/api/journal/entries?limit=${limit}`)
  return res.entries ?? []
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...buildAuthHeaders(getToken()), 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new ApiError(res.status, `POST ${path} failed: ${res.status}`)
  }
  return (await res.json()) as T
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { ...buildAuthHeaders(getToken()), 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new ApiError(res.status, `PUT ${path} failed: ${res.status}`)
  }
  return (await res.json()) as T
}

export async function postJournalEntry(
  content: string,
  mood?: string,
  tags?: string,
): Promise<{ id: number }> {
  const body: Record<string, string> = { content }
  if (mood) body.mood = mood
  if (tags) body.tags = tags
  return apiPost<{ id: number }>('/api/journal/entries', body)
}

export async function postWorkoutCheckin(note: string): Promise<{ sent: boolean }> {
  return apiPost<{ sent: boolean }>('/api/workout/checkin', { note })
}

export async function fetchClaudiaTodos(): Promise<ClaudiaTodosResponse> {
  return apiGet<ClaudiaTodosResponse>('/api/todos?owner=claudia')
}

export async function markTodoDone(id: string): Promise<{ ok: boolean }> {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Invalid todo id')
  }
  return apiPost<{ ok: boolean }>(`/api/todos/${id}/done`, {})
}

// Fleet screen types (Phase 2A, card 60abcc64)

export interface AgentSummary {
  name: string
  displayName: string
  description: string
  model: string
  running: boolean
  status: 'configured' | 'draft'
  contextPercent: number | null
  channelHealthy: boolean | null
  hasTelegram: boolean
  hasAvatar: boolean
}

export interface KanbanCardSummary {
  id: string
  title: string
  status: string
  priority: string
  assignee: string | null
  code: string | null
  project: string | null
}

export async function fetchFleetAgents(): Promise<AgentSummary[]> {
  return apiGet<AgentSummary[]>('/api/agents')
}

export async function fetchKanbanOpen(): Promise<KanbanCardSummary[]> {
  const all = await apiGet<KanbanCardSummary[]>('/api/kanban')
  return all.filter((c) => c.status === 'planned' || c.status === 'in_progress' || c.status === 'waiting')
}

// Office screen types (Phase 2B, card 62b0e71f)

export type AgentActivityLabel = 'working' | 'idle' | 'stopped' | 'unknown' | 'error'

export interface AgentActivity {
  name: string
  isMain: boolean
  running: boolean
  state: AgentActivityLabel
  tail: string[]
}

export async function fetchAgentActivity(): Promise<AgentActivity[]> {
  return apiGet<AgentActivity[]>('/api/agents/activity')
}

// Push settings types (Phase 2C, card 2f8257b2)

export interface PushSettings {
  workout: boolean
  todo: boolean
  fleet: boolean
  journal: boolean
}

export async function fetchPushSettings(): Promise<PushSettings> {
  return apiGet<PushSettings>('/api/push/settings')
}

export async function savePushSettings(settings: Partial<PushSettings>): Promise<PushSettings> {
  return apiPut<PushSettings>('/api/push/settings', settings)
}

// Showcase screen types (Phase 3B, card 0eff4b06)

export type ShowcaseState = 'running' | 'idle' | 'working' | 'stopped'

export interface ShowcaseAgentItem {
  roleLabel: string
  state: ShowcaseState
}

export interface ShowcaseAgentsResponse {
  agents: ShowcaseAgentItem[]
}

export interface ShowcaseTokenResponse {
  ok: boolean
  token: string
  jti: string
  expires_at: number
}

export async function fetchShowcaseAgents(): Promise<ShowcaseAgentItem[]> {
  const data = await apiGet<ShowcaseAgentsResponse>('/api/showcase/agents')
  return data.agents
}

export async function generateShowcaseShareToken(): Promise<ShowcaseTokenResponse> {
  return apiPost<ShowcaseTokenResponse>('/api/showcase/token', {})
}

// RPG screen types (Phase 3D, card 5138b7c7)

export interface RpgAchievement {
  id: string
  title: string
  unlocked_at: number
}

export interface RpgStatsResponse {
  totalXp: number
  level: number
  xpInLevel: number
  xpForNextLevel: number
  streak: number
  combo: number
  today: string
  recentAchievements: RpgAchievement[]
  sourceBreakdown: Record<string, number>
}

export async function fetchRpgStats(): Promise<RpgStatsResponse> {
  return apiGet<RpgStatsResponse>('/api/rpg/stats')
}

// TwelveWeekYear + LongTermTodo screen types (Phase 2D+2E, cards 2ecd1c93, b9e85b3a)

export interface MemoryEntry {
  id: number
  agent_id: string
  content: string
  category: string
  keywords: string
  created_at: number
  updated_at: number
}

export async function fetchTwelveWeekYearData(): Promise<MemoryEntry[]> {
  return apiGet<MemoryEntry[]>('/api/memories?agent=gelim&q=12wy&category=cold&limit=10')
}

export async function fetchLongTermTodos(): Promise<MemoryEntry[]> {
  return apiGet<MemoryEntry[]>('/api/memories?agent=claudia&q=&category=warm&limit=20')
}
