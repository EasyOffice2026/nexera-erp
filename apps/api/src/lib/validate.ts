import type { z } from 'zod';
import { errors } from './http-errors';

// Checks request data against a Zod schema. A failure becomes a 400 VALIDATION_ERROR
// that lists what was wrong.
export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw errors.validation(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
