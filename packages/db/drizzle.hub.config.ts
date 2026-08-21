import type { Config } from 'drizzle-kit'

export default {
  schema: './src/hub/schema.ts',
  out: './migrations/hub',
  dialect: 'sqlite',
} satisfies Config
