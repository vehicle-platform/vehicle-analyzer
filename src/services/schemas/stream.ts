import { z } from 'zod';

/**
 * WEB-3: runtime schemas of the vehicle-server /ws/live protocol (schemas/stream.py there).
 * Parsed at the boundary with `safeParse`; a malformed frame is dropped and counted, never thrown
 * into the render loop. Optional fields are lenient (a wrong type reads as absent), as before.
 */

const lenientNumber = z.number().optional().catch(undefined);

/** CAN identifier bounds: 29 bit extended is the widest. */
const CAN_ID_MAX = 0x1fffffff;

export const CanFrameDtoSchema = z.object({
  id: z.number().int().min(0).max(CAN_ID_MAX),
  data_hex: z.string(),
  channel: z.unknown().optional(),
  is_extended: z.unknown().optional(),
  dlc: lenientNumber,
  timestamp_us: lenientNumber,
});
export type CanFrameDto = z.infer<typeof CanFrameDtoSchema>;

export const StatsDtoSchema = z.object({
  bus_load_pct: lenientNumber,
  frame_rate_hz: lenientNumber,
  error_frames: lenientNumber,
});
export type StatsDto = z.infer<typeof StatsDtoSchema>;

export const HeartbeatDtoSchema = z.object({
  source: z.string(),
  dropped: lenientNumber,
});
export type HeartbeatDto = z.infer<typeof HeartbeatDtoSchema>;

/** A batch carries raw frame entries (each validated on its own, so one bad frame does not drop the batch). */
export const BatchDtoSchema = z.object({
  frames: z.array(z.unknown()).optional().catch(undefined),
  stats: z.unknown().optional(),
});
export type BatchDto = z.infer<typeof BatchDtoSchema>;

/** Envelope: {type, payload}. */
export const EnvelopeSchema = z.object({ type: z.string(), payload: z.unknown() });
