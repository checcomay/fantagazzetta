import { z, defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

const articlesCollection = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string(),
    matchday: z.string().default('Giornata'),
    publishDate: z.date(),
    bestPlayer: z.string().optional(),
    worstPlayer: z.string().optional(),
    bestGoal: z.string().optional(),
    author: z.string().default('Redazione'),
    image: z.string().optional(),
  }),
});

export const collections = {
  'articles': articlesCollection,
};