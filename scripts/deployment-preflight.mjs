import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { checkedRoot, isPathContained, readCheckedFile } from './typescript-imports.mjs';

export const MAX_EXPORT_ATTEMPTS = 5;
export const MAX_OUTBOX_CONSUMER_ATTEMPTS = MAX_EXPORT_ATTEMPTS + 1;
export const MAX_OUTBOX_RETRIES = MAX_OUTBOX_CONSUMER_ATTEMPTS - 1;
export const OUTBOX_LEASE_SECONDS = 5 * 60;
export const OUTBOX_LEASE_MILLISECONDS = OUTBOX_LEASE_SECONDS * 1000;
export const OUTBOX_MAX_BATCH_SIZE = 20;
export const OUTBOX_MAX_BATCH_TIMEOUT_SECONDS = 5;
export const MAX_DEPLOYMENT_CONFIG_BYTES = 1024 * 1024;

const expectedBindingNames = Object.freeze({
  database: 'DB',
  bucket: 'EXPORTS_BUCKET',
  queue: 'EVENT_QUEUE',
});

const argumentsList = process.argv.slice(2);
const configPath = optionValue('--config');
const localMode = argumentsList.includes('--local');
const environmentName = optionValue('--env') ?? 'development';

export async function readDeploymentConfig(configPath, repositoryRoot = process.cwd()) {
  const checkedRepositoryRoot = await checkedRoot(repositoryRoot);
  const absoluteConfigPath = path.resolve(repositoryRoot, configPath);
  assert(
    isPathContained(checkedRepositoryRoot, absoluteConfigPath),
    `configuration path must remain inside the repository: ${configPath}`,
  );
  const source = await readCheckedFile(absoluteConfigPath, checkedRepositoryRoot, {
    maxBytes: MAX_DEPLOYMENT_CONFIG_BYTES,
  });
  return parseJsonc(source, absoluteConfigPath);
}

export function validateDeploymentConfig(config, options = {}) {
  const mode = options.mode ?? 'production';
  const requestedEnvironment = options.environmentName ?? 'development';
  assertRecord(config, 'Wrangler config');
  assert(config.workers_dev === false, 'Deployment requires workers_dev=false.');
  assert(config.preview_urls === false, 'Deployment requires preview_urls=false.');
  assertExactBindings(config, { mode, label: 'root' });

  if (mode === 'production') {
    assertNoEnvironmentOverrides(config);
    validateProductionRuntime(config);
    validateOperatorBindings(config);
    assertCronTrigger(config);
    return;
  }
  if (mode !== 'local') throw new Error(`Unsupported deployment preflight mode: ${mode}.`);

  validateSharedRuntime(config);
  const environments = config.env;
  assertRecord(environments, 'Wrangler env');
  assertExactObjectKeys(environments, [requestedEnvironment], 'Wrangler env');
  const environment = environments[requestedEnvironment];
  assertRecord(environment, `Wrangler env.${requestedEnvironment}`);
  assert(
    environment.workers_dev === undefined,
    `env.${requestedEnvironment} must not override workers_dev.`,
  );
  assert(
    environment.preview_urls === undefined,
    `env.${requestedEnvironment} must not override preview_urls.`,
  );
  assertExactBindings(environment, { mode, label: `env.${requestedEnvironment}` });
  if (requestedEnvironment === 'development') validateDevelopmentRuntime(environment);
  else
    throw new Error(
      `Local preflight only supports env.development, not env.${requestedEnvironment}.`,
    );
}

function validateProductionRuntime(config) {
  assertValue(config.name, 'name');
  assertValue(config.account_id, 'account_id');
  assertValue(config.vars?.ACCESS_TEAM_DOMAIN, 'vars.ACCESS_TEAM_DOMAIN');
  assertValue(config.vars?.ACCESS_AUD, 'vars.ACCESS_AUD');
  assertValue(config.vars?.BACKUP_ACTOR_ID, 'vars.BACKUP_ACTOR_ID');
  assert(config.vars?.ENVIRONMENT === 'production', 'Deployment requires ENVIRONMENT=production.');
  assert(config.vars?.ALLOW_LOCAL_AUTH === 'false', 'Deployment requires ALLOW_LOCAL_AUTH=false.');
}

function validateSharedRuntime(config) {
  assert(
    config.vars?.ENVIRONMENT === 'production',
    'Shared config requires ENVIRONMENT=production.',
  );
  assert(
    config.vars?.ALLOW_LOCAL_AUTH === 'false',
    'Shared config requires ALLOW_LOCAL_AUTH=false.',
  );
}

function validateDevelopmentRuntime(environment) {
  assert(
    environment.vars?.ENVIRONMENT === 'development',
    'env.development requires ENVIRONMENT=development.',
  );
  assert(
    environment.vars?.ALLOW_LOCAL_AUTH === 'true',
    'env.development requires ALLOW_LOCAL_AUTH=true.',
  );
  assert(
    environment.vars?.ACCESS_TEAM_DOMAIN === 'unset',
    'env.development must leave ACCESS_TEAM_DOMAIN unset.',
  );
  assert(environment.vars?.ACCESS_AUD === 'unset', 'env.development must leave ACCESS_AUD unset.');
}

function assertExactBindings(config, { mode, label }) {
  const databaseEntries = exactArray(config.d1_databases, `${label}.d1_databases`);
  assert(databaseEntries.length === 1, `${label}.d1_databases must contain exactly one binding.`);
  const database = databaseEntries[0];
  assertRecord(database, `${label}.d1_databases[0]`);
  assertExactObjectKeys(
    database,
    mode === 'production'
      ? ['binding', 'database_name', 'database_id', 'migrations_dir']
      : ['binding', 'migrations_dir'],
    `${label}.d1_databases[0]`,
  );
  assert(
    database.binding === expectedBindingNames.database,
    `${label}.d1_databases[0].binding must be DB.`,
  );
  assert(
    database.migrations_dir === 'migrations',
    `${label}.d1_databases[0] must use migrations/.`,
  );
  if (mode === 'production') {
    assertValue(database.database_name, `${label}.d1_databases[0].database_name`);
    assertValue(database.database_id, `${label}.d1_databases[0].database_id`);
  }

  const buckets = exactArray(config.r2_buckets, `${label}.r2_buckets`);
  assert(buckets.length === 1, `${label}.r2_buckets must contain exactly one binding.`);
  const bucket = buckets[0];
  assertRecord(bucket, `${label}.r2_buckets[0]`);
  assertExactObjectKeys(bucket, ['binding', 'bucket_name'], `${label}.r2_buckets[0]`);
  assert(
    bucket.binding === expectedBindingNames.bucket,
    `${label}.r2_buckets[0].binding must be EXPORTS_BUCKET.`,
  );
  assertValue(bucket.bucket_name, `${label}.r2_buckets[0].bucket_name`);

  assertRecord(config.queues, `${label}.queues`);
  assertExactObjectKeys(config.queues, ['producers', 'consumers'], `${label}.queues`);
  const producers = exactArray(config.queues.producers, `${label}.queues.producers`);
  const consumers = exactArray(config.queues.consumers, `${label}.queues.consumers`);
  assert(producers.length === 1, `${label}.queues.producers must contain exactly one binding.`);
  assert(consumers.length === 1, `${label}.queues.consumers must contain exactly one binding.`);
  const producer = producers[0];
  const consumer = consumers[0];
  assertRecord(producer, `${label}.queues.producers[0]`);
  assertRecord(consumer, `${label}.queues.consumers[0]`);
  assertExactObjectKeys(producer, ['binding', 'queue'], `${label}.queues.producers[0]`);
  assertExactObjectKeys(
    consumer,
    [
      'queue',
      'max_batch_size',
      'max_batch_timeout',
      'max_retries',
      'visibility_timeout_ms',
      'dead_letter_queue',
      'retry_delay',
    ],
    `${label}.queues.consumers[0]`,
  );
  assert(
    producer.binding === expectedBindingNames.queue,
    `${label}.queues.producers[0].binding must be EVENT_QUEUE.`,
  );
  assertValue(producer.queue, `${label}.queues.producers[0].queue`);
  assertValue(consumer.queue, `${label}.queues.consumers[0].queue`);
  assert(
    consumer.queue === producer.queue,
    `${label} producer and consumer must use the same primary Queue.`,
  );
  assertValue(consumer.dead_letter_queue, `${label}.queues.consumers[0].dead_letter_queue`);
  assert(
    consumer.dead_letter_queue !== producer.queue,
    `${label} dead-letter queue must differ from the primary Queue.`,
  );
  assert(
    consumer.max_batch_size === OUTBOX_MAX_BATCH_SIZE,
    `${label}.queues.consumers[0].max_batch_size must be ${OUTBOX_MAX_BATCH_SIZE}.`,
  );
  assert(
    consumer.max_batch_timeout === OUTBOX_MAX_BATCH_TIMEOUT_SECONDS,
    `${label}.queues.consumers[0].max_batch_timeout must be ${OUTBOX_MAX_BATCH_TIMEOUT_SECONDS}s.`,
  );
  assert(
    consumer.max_retries === MAX_OUTBOX_RETRIES,
    `${label}.queues.consumers[0].max_retries must be ${MAX_OUTBOX_RETRIES}.`,
  );
  assert(
    consumer.visibility_timeout_ms === OUTBOX_LEASE_MILLISECONDS,
    `${label}.queues.consumers[0].visibility_timeout_ms must be ${OUTBOX_LEASE_MILLISECONDS}ms.`,
  );
  assert(
    consumer.retry_delay === OUTBOX_LEASE_SECONDS,
    `${label}.queues.consumers[0].retry_delay must be ${OUTBOX_LEASE_SECONDS}s.`,
  );
}

function validateOperatorBindings(config) {
  assert(config.d1_databases[0].database_name !== 'unset', 'Operator D1 database_name is unset.');
  assert(config.d1_databases[0].database_id !== 'unset', 'Operator D1 database_id is unset.');
  assert(config.r2_buckets[0].bucket_name !== 'unset', 'Operator R2 bucket_name is unset.');
  assert(config.queues.producers[0].queue !== 'unset', 'Operator primary Queue is unset.');
  assert(
    config.queues.consumers[0].dead_letter_queue !== 'unset',
    'Operator dead-letter Queue is unset.',
  );
}

function assertCronTrigger(config) {
  const crons = config.triggers?.crons;
  assert(
    Array.isArray(crons) && crons.length > 0,
    'Deployment requires an operator-owned Cron Trigger.',
  );
  for (const [index, cron] of crons.entries()) assertValue(cron, `triggers.crons[${index}]`);
}

function assertNoEnvironmentOverrides(config) {
  if (config.env === undefined) return;
  assertRecord(config.env, 'env');
  assert(
    Object.keys(config.env).length === 0,
    'Production preflight requires one effective config and rejects env overrides.',
  );
}

function optionValue(name) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return undefined;
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function exactArray(value, field) {
  assert(Array.isArray(value), `${field} must be an array.`);
  return value;
}

function assertRecord(value, field) {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${field} must be an object.`,
  );
}

function assertExactObjectKeys(value, keys, field) {
  assertRecord(value, field);
  const expected = new Set(keys);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(sortedExpected),
    `${field} contains unsupported or missing properties.`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(`deployment preflight failed: ${message}`);
}

function assertValue(value, field) {
  assert(typeof value === 'string' && value.length > 0, `${field} is required.`);
  assert(!/^unset$/i.test(value), `${field} is unset.`);
  assert(!value.includes('__'), `${field} still contains an operator placeholder.`);
  assert(
    !/operator[-_ ]?supplied|change[-_ ]?me|example|placeholder/i.test(value),
    `${field} is still an example value.`,
  );
}

export function parseJsonc(source, sourcePath = '<jsonc>') {
  try {
    return new JsoncParser(source).parse();
  } catch (error) {
    throw new Error(
      `Cannot parse ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

class JsoncParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.depth = 0;
  }

  parse() {
    const value = this.parseValue('$');
    this.skipIgnored();
    if (this.index !== this.source.length) this.fail('unexpected trailing input');
    return value;
  }

  parseValue(location) {
    this.skipIgnored();
    const character = this.source[this.index];
    if (character === '{') return this.parseObject(location);
    if (character === '[') return this.parseArray(location);
    if (character === '"') return this.parseString();
    if (this.source.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    if (character === '-' || /[0-9]/.test(character ?? '')) return this.parseNumber();
    this.fail(`expected a JSON value at ${location}`);
  }

  parseObject(location) {
    this.enterComposite(location);
    this.index += 1;
    const value = Object.create(null);
    const keys = new Set();
    this.skipIgnored();
    if (this.consume('}')) {
      this.leaveComposite();
      return value;
    }
    while (true) {
      this.skipIgnored();
      if (this.source[this.index] !== '"') this.fail(`expected a quoted key at ${location}`);
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate key ${JSON.stringify(key)} at ${location}`);
      keys.add(key);
      this.skipIgnored();
      if (!this.consume(':')) this.fail(`expected ':' after ${JSON.stringify(key)}`);
      value[key] = this.parseValue(`${location}.${key}`);
      this.skipIgnored();
      if (this.consume('}')) {
        this.leaveComposite();
        return value;
      }
      if (!this.consume(',')) this.fail(`expected ',' or '}' at ${location}`);
      this.skipIgnored();
      if (this.consume('}')) {
        this.leaveComposite();
        return value;
      }
    }
  }

  parseArray(location) {
    this.enterComposite(location);
    this.index += 1;
    const value = [];
    this.skipIgnored();
    if (this.consume(']')) {
      this.leaveComposite();
      return value;
    }
    while (true) {
      value.push(this.parseValue(`${location}[${value.length}]`));
      this.skipIgnored();
      if (this.consume(']')) {
        this.leaveComposite();
        return value;
      }
      if (!this.consume(',')) this.fail(`expected ',' or ']' at ${location}`);
      this.skipIgnored();
      if (this.consume(']')) {
        this.leaveComposite();
        return value;
      }
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (character === '"') {
        try {
          return JSON.parse(this.source.slice(start, this.index));
        } catch (error) {
          this.fail(
            `invalid JSON string: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (character === '\n' || character === '\r') this.fail('unescaped newline in string');
    }
    this.fail('unterminated JSON string');
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.index),
    );
    if (match === null) this.fail('invalid JSON number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('JSON number is outside the supported range');
    return value;
  }

  skipIgnored() {
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (/\s/.test(character)) {
        this.index += 1;
        continue;
      }
      if (character !== '/' || this.source[this.index + 1] === undefined) return;
      const next = this.source[this.index + 1];
      if (next === '/') {
        this.index += 2;
        while (
          this.index < this.source.length &&
          this.source[this.index] !== '\n' &&
          this.source[this.index] !== '\r'
        ) {
          this.index += 1;
        }
        continue;
      }
      if (next === '*') {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end < 0) this.fail('unterminated block comment');
        this.index = end + 2;
        continue;
      }
      return;
    }
  }

  enterComposite(location) {
    this.depth += 1;
    if (this.depth > 64) this.fail(`JSON nesting exceeds the limit at ${location}`);
  }

  leaveComposite() {
    this.depth -= 1;
  }

  consume(character) {
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  fail(message) {
    throw new Error(`${message} near byte ${this.index}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (configPath === undefined) throw new Error('Pass --config <wrangler-config>.');
  const config = await readDeploymentConfig(configPath);
  validateDeploymentConfig(config, {
    mode: localMode ? 'local' : 'production',
    environmentName,
  });
  globalThis.console.log(
    localMode
      ? `deployment preflight passed for inert local config: ${configPath}`
      : `deployment preflight passed for operator config: ${configPath}`,
  );
}
