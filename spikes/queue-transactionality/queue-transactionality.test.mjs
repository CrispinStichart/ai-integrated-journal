import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { fromDrizzle, PgBoss } from 'pg-boss'

const { Pool } = pg
const queueName = 'queue-transactionality-spike'
const forcedRollback = new Error('force the transaction to roll back')

const journalEvents = pgTable('journal_event', {
  id: uuid('id').primaryKey(),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

let container
let pool
let database
let boss

before(async () => {
  container = await new PostgreSqlContainer('postgres:17.6-alpine').start()
  pool = new Pool({ connectionString: container.getConnectionUri() })
  database = drizzle({ client: pool })

  await pool.query(`
    CREATE TABLE journal_event (
      id uuid PRIMARY KEY,
      description text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  boss = new PgBoss({ connectionString: container.getConnectionUri() })
  boss.on('error', (error) => {
    throw error
  })
  await boss.start()
  await boss.createQueue(queueName)
})

after(async () => {
  await boss?.stop({ graceful: false })
  await pool?.end()
  await container?.stop()
})

async function persistedJob(jobId) {
  const result = await pool.query(
    'SELECT id, name, data, state FROM pgboss.job WHERE id = $1',
    [jobId],
  )
  return result.rows[0]
}

test('ADR-0007: queue job and Drizzle mutation become visible on the same commit', async () => {
  const eventId = randomUUID()
  const jobId = randomUUID()

  await database.transaction(async (transaction) => {
    await transaction.insert(journalEvents).values({
      id: eventId,
      description: 'committed event',
    })

    const insertedJobId = await boss.send(
      queueName,
      { eventId, schemaVersion: 1 },
      { db: fromDrizzle(transaction, sql), id: jobId },
    )

    assert.equal(insertedJobId, jobId)
  })

  const [event] = await database
    .select()
    .from(journalEvents)
    .where(eq(journalEvents.id, eventId))
  const job = await persistedJob(jobId)

  assert.equal(event.description, 'committed event')
  assert.equal(job.name, queueName)
  assert.deepEqual(job.data, { eventId, schemaVersion: 1 })
  assert.equal(job.state, 'created')
})

test('ADR-0007: queue job and Drizzle mutation are both absent after rollback', async () => {
  const eventId = randomUUID()
  const jobId = randomUUID()

  await assert.rejects(
    database.transaction(async (transaction) => {
      await transaction.insert(journalEvents).values({
        id: eventId,
        description: 'rolled-back event',
      })

      const insertedJobId = await boss.send(
        queueName,
        { eventId, schemaVersion: 1 },
        { db: fromDrizzle(transaction, sql), id: jobId },
      )

      assert.equal(insertedJobId, jobId)
      throw forcedRollback
    }),
    forcedRollback,
  )

  const events = await database
    .select()
    .from(journalEvents)
    .where(eq(journalEvents.id, eventId))
  const job = await persistedJob(jobId)

  assert.deepEqual(events, [])
  assert.equal(job, undefined)
})
