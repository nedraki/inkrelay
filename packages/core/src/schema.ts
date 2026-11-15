import { z } from "zod";
import { PEN_EVENT_SCHEMA_VERSION } from "./types.js";

export const penDotEventSchema = z.object({
  schemaVersion: z.literal(PEN_EVENT_SCHEMA_VERSION),
  eventType: z.enum(["pen_down", "pen_move", "pen_up"]),
  source: z.enum(["web_bluetooth", "native_bridge", "replay", "mock"]),
  sessionId: z.string().min(1),
  penId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative(),
  notebookId: z.string().min(1),
  pageId: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  pressure: z.number().finite().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  coordinateSpace: z.literal("app_px")
});
