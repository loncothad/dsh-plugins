/** fal's advertised task categories and their input/output modalities. */
import type { MediaInputKind, MediaModality } from '@loncothad/dsh-media-gen'

const CATEGORY_MAP: Readonly<
  Record<string, { outputs: readonly MediaModality[]; inputs: readonly MediaInputKind[] }>
> = {
  'speech-to-text': { outputs: ['text'], inputs: ['audio'] },
  'audio-to-text': { outputs: ['text'], inputs: ['audio'] },
  'image-to-text': { outputs: ['text'], inputs: ['image'] },
  'video-to-text': { outputs: ['text'], inputs: ['video'] },
  vision: { outputs: ['text'], inputs: ['text', 'image'] },
  'text-to-image': { outputs: ['image'], inputs: ['text'] },
  'image-to-image': { outputs: ['image'], inputs: ['text', 'image'] },
  'text-to-video': { outputs: ['video'], inputs: ['text'] },
  'image-to-video': { outputs: ['video'], inputs: ['text', 'image'] },
  'video-to-video': { outputs: ['video'], inputs: ['text', 'video'] },
  'audio-to-video': { outputs: ['video'], inputs: ['text', 'audio'] },
  'text-to-audio': { outputs: ['audio'], inputs: ['text'] },
  'text-to-speech': { outputs: ['audio'], inputs: ['text'] },
  'video-to-audio': { outputs: ['audio'], inputs: ['text', 'video'] },
  'audio-to-audio': { outputs: ['audio'], inputs: ['text', 'audio'] },
  'speech-to-speech': { outputs: ['audio'], inputs: ['text', 'audio'] },
  'text-to-3d': { outputs: ['3d'], inputs: ['text'] },
  'image-to-3d': { outputs: ['3d'], inputs: ['text', 'image'] },
  '3d-to-3d': { outputs: ['3d'], inputs: ['text', '3d'] },
}
/** Map one fal category to media transitions, when it is a generation category. */
export function transitionsOf(
  category: string,
): { outputs: readonly MediaModality[]; inputs: readonly MediaInputKind[] } | undefined {
  return CATEGORY_MAP[category.toLowerCase()]
}
