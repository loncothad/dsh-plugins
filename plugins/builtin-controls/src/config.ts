import z from '@deepseek-ai/schemastery'
export const schema = z.object({
  disabledSkills: z
    .array(z.string())
    .default([])
    .description(
      'Exact skill names disabled for future model and human invocation in this profile.',
    ),
})
