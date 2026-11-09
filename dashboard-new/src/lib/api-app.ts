import { apiGet, getToken, buildAuthHeaders, ApiError } from './api'

export interface WorkoutExercise {
  name: string
  sets: number
  reps: number
  weight: number
  unit: string
}

export interface WorkoutPlan {
  date: string
  exercises: WorkoutExercise[]
  notes: string
}

export interface AppCalendarEvent {
  id: string
  summary: string
  start: string
  end: string
  location: string
  description: string
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
