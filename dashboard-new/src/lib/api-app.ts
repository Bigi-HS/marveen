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
  createdAt: string
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
  return apiPost<{ ok: boolean }>(`/api/todos/${id}/done`, {})
}
