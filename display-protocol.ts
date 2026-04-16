/**
 * display-protocol.ts — Common display event types for the dashboard.
 *
 * Providers optionally export a `mapTranscript` function conforming to
 * `TranscriptMapper` to normalize their native transcript formats.
 */

export type DisplayEvent =
  | { t: "start"; ts: number; provider: string; model?: string; cwd: string }
  | { t: "thinking"; ts: number; text: string }
  | { t: "text"; ts: number; text: string; final: boolean }
  | { t: "tool_start"; ts: number; id: string; name: string; args: Record<string, string> }
  | { t: "tool_end"; ts: number; id: string; name: string; result: string }
  | { t: "subagent_start"; ts: number; id: string; name: string; desc: string }
  | { t: "subagent_end"; ts: number; id: string; tools: number; duration_ms: number }
  | { t: "error"; ts: number; text: string }
  | { t: "end"; ts: number }

export type TranscriptMapper = (line: string) => DisplayEvent | DisplayEvent[] | null

export interface ProviderMeta {
  transcriptPath: string
  provider: string
}
