import type { Config } from 'drizzle-kit'

export default {
  schema: './src/client/schema.ts',
  out: './migrations/client',
  dialect: 'sqlite',
} satisfies Config
