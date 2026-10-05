import { z as validate } from 'zod'

export const disabledSkillsSchema = validate
  .array(
    validate
      .string()
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  )
  .max(512)
  .transform((names) => [...new Set(names)].sort())
