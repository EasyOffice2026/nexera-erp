import { z } from 'zod';

// Names that people read are kept in English and Arabic.
export const localizedNameSchema = z.object({
  en: z.string().trim().min(1).max(200),
  ar: z.string().trim().min(1).max(200),
});

export type LocalizedName = z.infer<typeof localizedNameSchema>;
