import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAdminProductsService,
  maximumProductDescriptionBytes,
  parseProductId,
  validateNewProduct,
  validateProductChanges,
} from '../src/services/adminProducts.service.js';

function productRow(overrides = {}) {
  return {
    id: '1',
    categoryId: '2',
    categoryName: 'نوشیدنی گرم',
    name: 'قهوه',
    description: 'قهوه تازه‌دم',
    price: '125000',
    sortOrder: 3,
    isAvailable: 1,
    isVisible: 1,
    ...overrides,
  };
}

function createTransactionHarness({
  id = '9223372036854775808',
  insertId = -9_223_372_036_854_776_000,
  categoryRows = [{ id: 2 }],
  lastIdRows,
  reloadRows,
  failures = {},
} = {}) {
  const events = [];
  const queries = [];
  let releaseCount = 0;
  const connection = {
    async beginTransaction() {
      events.push('beginTransaction');

      if (failures.begin) {
        throw failures.begin;
      }
    },
    async execute(sql, parameters) {
      queries.push({ sql, parameters });

      if (sql.includes('FROM categories')) {
        events.push('selectCategory');

        if (failures.category) {
          throw failures.category;
        }

        return [categoryRows, []];
      }

      if (sql.includes('INSERT INTO menu_items')) {
        events.push('insertProduct');

        if (failures.insert) {
          throw failures.insert;
        }

        return [{ insertId, affectedRows: 1 }, []];
      }

      if (sql.includes('LAST_INSERT_ID()')) {
        events.push('selectLastInsertId');

        if (failures.lastId) {
          throw failures.lastId;
        }

        return [lastIdRows ?? [{ id }], []];
      }

      if (sql.includes('FROM menu_items AS menuItems')) {
        events.push('reloadProduct');

        if (failures.reload) {
          throw failures.reload;
        }

        return [reloadRows ?? [productRow({ id })], []];
      }

      throw new Error(`Unexpected SQL in create transaction harness: ${sql}`);
    },
    async commit() {
      events.push('commit');

      if (failures.commit) {
        throw failures.commit;
      }
    },
    async rollback() {
      events.push('rollback');

      if (failures.rollback) {
        throw failures.rollback;
      }
    },
    release() {
      releaseCount += 1;
      events.push('release');

      if (failures.release) {
        throw failures.release;
      }
    },
  };
  const pool = {
    async getConnection() {
      events.push('getConnection');

      if (failures.getConnection) {
        throw failures.getConnection;
      }

      return connection;
    },
    async execute() {
      throw new Error('Create must not execute a query through the pool.');
    },
  };

  return {
    events,
    queries,
    pool,
    get releaseCount() {
      return releaseCount;
    },
  };
}

test('lists products deterministically and maps only the camelCase API contract', async () => {
  const calls = [];
  const service = createAdminProductsService({
    executor: {
      async execute(sql, parameters) {
        calls.push({ sql, parameters });
        return [[productRow({ isAvailable: 0 })], []];
      },
    },
  });

  const products = await service.list();

  assert.match(calls[0].sql, /JOIN categories ON categories\.id = menuItems\.category_id/);
  assert.match(calls[0].sql, /ORDER BY menuItems\.display_order ASC, menuItems\.id ASC/);
  assert.match(calls[0].sql, /CAST\(menuItems\.price AS CHAR\) AS price/);
  assert.equal(calls[0].parameters, undefined);
  assert.deepEqual(products, [
    {
      id: '1',
      categoryId: '2',
      categoryName: 'نوشیدنی گرم',
      name: 'قهوه',
      description: 'قهوه تازه‌دم',
      price: '125000',
      sortOrder: 3,
      isAvailable: false,
      isVisible: true,
    },
  ]);
});

test('creates products atomically with exact unsigned BIGINT ids', async (context) => {
  for (const [id, misleadingInsertId] of [
    ['9223372036854775807', Number.MAX_SAFE_INTEGER],
    ['9223372036854775808', -9_223_372_036_854_776_000],
    ['18446744073709551615', -1],
  ]) {
    await context.test(`preserves id ${id}`, async () => {
      const injectedName = "  قهوه', is_visible = 0 --  ";
      const harness = createTransactionHarness({
        id,
        insertId: misleadingInsertId,
        reloadRows: [
          productRow({ id, name: injectedName.trim(), isVisible: 0 }),
        ],
      });
      const service = createAdminProductsService({ executor: harness.pool });
      const created = await service.create({
        categoryId: 2,
        name: injectedName,
        description: null,
        price: '18446744073709551615',
        sortOrder: 4,
        isAvailable: true,
        isVisible: false,
      });
      const insert = harness.queries.find((call) =>
        call.sql.includes('INSERT INTO menu_items'),
      );
      const lastId = harness.queries.find((call) =>
        call.sql.includes('LAST_INSERT_ID()'),
      );
      const reload = harness.queries.find((call) =>
        call.sql.includes('FROM menu_items AS menuItems'),
      );

      assert.deepEqual(harness.events, [
        'getConnection',
        'beginTransaction',
        'selectCategory',
        'insertProduct',
        'selectLastInsertId',
        'reloadProduct',
        'commit',
        'release',
      ]);
      assert.equal(harness.releaseCount, 1);
      assert.equal(insert.sql.includes(injectedName.trim()), false);
      assert.doesNotMatch(insert.sql, /image_path/);
      assert.deepEqual(insert.parameters, [
        2,
        injectedName.trim(),
        null,
        '18446744073709551615',
        4,
        1,
        0,
      ]);
      assert.equal(lastId.sql, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
      assert.equal(lastId.parameters, undefined);
      assert.deepEqual(reload.parameters, [id]);
      assert.equal(created.id, id);
      assert.equal(created.isVisible, false);
    });
  }
});

test('returns the committed product when synchronous release cleanup fails', async () => {
  const id = '18446744073709551615';
  const harness = createTransactionHarness({
    id,
    insertId: -1,
    reloadRows: [productRow({ id, price: '18446744073709551615' })],
    failures: { release: new Error('release listener failed') },
  });
  const service = createAdminProductsService({ executor: harness.pool });

  const created = await service.create({
    categoryId: 2,
    name: 'Committed product',
    price: '18446744073709551615',
  });
  const lastId = harness.queries.find((call) =>
    call.sql.includes('LAST_INSERT_ID()'),
  );
  const reload = harness.queries.find((call) =>
    call.sql.includes('FROM menu_items AS menuItems'),
  );

  assert.deepEqual(harness.events, [
    'getConnection',
    'beginTransaction',
    'selectCategory',
    'insertProduct',
    'selectLastInsertId',
    'reloadProduct',
    'commit',
    'release',
  ]);
  assert.equal(harness.events.filter((event) => event === 'commit').length, 1);
  assert.equal(harness.events.filter((event) => event === 'rollback').length, 0);
  assert.equal(harness.releaseCount, 1);
  assert.equal(lastId.sql, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
  assert.equal(lastId.parameters, undefined);
  assert.deepEqual(reload.parameters, [id]);
  assert.equal(created.id, id);
  assert.equal(created.price, '18446744073709551615');
});

test('handles failed product creates with the correct rollback and release semantics', async (context) => {
  const body = { categoryId: 2, name: 'قهوه', price: '100' };

  await context.test('getConnection failure', async () => {
    const databaseError = new Error('connection acquisition failed');
    const harness = createTransactionHarness({
      failures: { getConnection: databaseError },
    });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, ['getConnection']);
    assert.equal(harness.releaseCount, 0);
  });

  await context.test('beginTransaction failure', async () => {
    const databaseError = new Error('transaction start failed');
    const harness = createTransactionHarness({ failures: { begin: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, ['getConnection', 'beginTransaction', 'release']);
    assert.equal(harness.events.includes('rollback'), false);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('category query failure', async () => {
    const databaseError = new Error('category query failed');
    const harness = createTransactionHarness({ failures: { category: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('invalid non-empty LAST_INSERT_ID result', async () => {
    const harness = createTransactionHarness({ lastIdRows: [{ id: 1 }] });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), /Created product id could not be loaded/);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'selectLastInsertId',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('LAST_INSERT_ID query failure', async () => {
    const databaseError = new Error('last id query failed');
    const harness = createTransactionHarness({ failures: { lastId: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'selectLastInsertId',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('missing LAST_INSERT_ID row', async () => {
    const harness = createTransactionHarness({ lastIdRows: [] });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), /Created product id could not be loaded/);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'selectLastInsertId',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('reload query failure', async () => {
    const databaseError = new Error('reload failed');
    const harness = createTransactionHarness({ failures: { reload: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'selectLastInsertId',
      'reloadProduct',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('reload returns no product', async () => {
    const harness = createTransactionHarness({ reloadRows: [] });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), /Created product could not be loaded/);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'selectLastInsertId',
      'reloadProduct',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('insert failure', async () => {
    const databaseError = new Error('insert failed');
    const harness = createTransactionHarness({ failures: { insert: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('commit failure', async () => {
    const databaseError = new Error('commit failed');
    const harness = createTransactionHarness({ failures: { commit: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(service.create(body), (error) => error === databaseError);
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'selectLastInsertId',
      'reloadProduct',
      'commit',
      'rollback',
      'release',
    ]);
    assert.equal(harness.events.filter((event) => event === 'commit').length, 1);
    assert.equal(harness.events.filter((event) => event === 'rollback').length, 1);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('category foreign-key race', async () => {
    const databaseError = Object.assign(new Error('sensitive FK metadata'), {
      code: 'ER_NO_REFERENCED_ROW_2',
      errno: 1452,
    });
    const harness = createTransactionHarness({ failures: { insert: databaseError } });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(
      service.create(body),
      (error) =>
        error.status === 400 &&
        error.code === 'INVALID_PRODUCT_CATEGORY' &&
        error.message.includes('sensitive') === false,
    );
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('cleanup errors retain the original failure', async () => {
    const primaryError = new Error('primary insert failure');
    const rollbackError = new Error('rollback failure');
    const releaseError = new Error('release failure');
    const harness = createTransactionHarness({
      failures: {
        insert: primaryError,
        rollback: rollbackError,
        release: releaseError,
      },
    });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(
      service.create(body),
      (error) =>
        error instanceof AggregateError &&
        error.cause === primaryError &&
        error.errors[0] === primaryError &&
        error.errors[1] === rollbackError &&
        error.errors[2] === releaseError,
    );
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'insertProduct',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });
});

test('validates create defaults and partial updates without unsafe coercion', () => {
  assert.deepEqual(
    validateNewProduct({ categoryId: 2, name: '  قهوه  ', price: '0' }),
    {
      categoryId: 2,
      name: 'قهوه',
      description: null,
      price: '0',
      sortOrder: 0,
      isAvailable: true,
      isVisible: true,
    },
  );
  assert.deepEqual(
    validateProductChanges({
      description: '  توضیح با فاصله  ',
      isAvailable: false,
      isVisible: false,
    }),
    {
      description: '  توضیح با فاصله  ',
      isAvailable: false,
      isVisible: false,
    },
  );
  assert.equal(parseProductId('18446744073709551615'), '18446744073709551615');
});

test('validates the exact UTF-8 byte boundary for product descriptions', () => {
  const exactAsciiBoundary = 'a'.repeat(maximumProductDescriptionBytes);
  const overAsciiBoundary = `${exactAsciiBoundary}a`;
  const exactEmojiBoundary = `${'🙂'.repeat(16_383)}abc`;
  const overEmojiBoundary = `${exactEmojiBoundary}d`;

  assert.equal(Buffer.byteLength(exactAsciiBoundary, 'utf8'), 65_535);
  assert.equal(Buffer.byteLength(overAsciiBoundary, 'utf8'), 65_536);
  assert.equal(Buffer.byteLength(exactEmojiBoundary, 'utf8'), 65_535);
  assert.equal(Buffer.byteLength(overEmojiBoundary, 'utf8'), 65_536);
  assert.equal(
    validateProductChanges({ description: exactAsciiBoundary }).description,
    exactAsciiBoundary,
  );
  assert.equal(
    validateProductChanges({ description: exactEmojiBoundary }).description,
    exactEmojiBoundary,
  );
  assert.throws(
    () => validateProductChanges({ description: overAsciiBoundary }),
    (error) => error.status === 400 && error.code === 'INVALID_PRODUCT_DESCRIPTION',
  );
  assert.throws(
    () => validateProductChanges({ description: overEmojiBoundary }),
    (error) => error.status === 400 && error.code === 'INVALID_PRODUCT_DESCRIPTION',
  );
});

test('accepts only canonical unsigned BIGINT price strings', () => {
  for (const price of [
    '0',
    '9007199254740991',
    '9007199254740992',
    '18446744073709551615',
  ]) {
    assert.equal(validateProductChanges({ price }).price, price);
  }

  for (const price of [
    '18446744073709551616',
    '+12',
    ' 12',
    '12 ',
    '1e3',
    '0x10',
    '01',
  ]) {
    assert.throws(
      () => validateProductChanges({ price }),
      (error) => error.status === 400 && error.code === 'INVALID_PRODUCT_PRICE',
    );
  }
});

test('rejects invalid product names, descriptions, references, prices, ordering, and fields', () => {
  const valid = { categoryId: 2, name: 'قهوه', price: '100' };
  const invalidBodies = [
    { name: 'قهوه', price: '100' },
    { ...valid, name: '   ' },
    { ...valid, name: 'a'.repeat(151) },
    { ...valid, name: 12 },
    { ...valid, name: false },
    { ...valid, name: [] },
    { ...valid, name: {} },
    { ...valid, description: 12 },
    { ...valid, description: false },
    { ...valid, description: [] },
    { ...valid, description: {} },
    { ...valid, description: 'a'.repeat(maximumProductDescriptionBytes + 1) },
    { ...valid, categoryId: 0 },
    { ...valid, categoryId: -1 },
    { ...valid, categoryId: 1.5 },
    { ...valid, categoryId: '2' },
    { ...valid, price: '-1' },
    { ...valid, price: '1.1' },
    { ...valid, price: '12abc' },
    { ...valid, price: '01' },
    { ...valid, price: '18446744073709551616' },
    { ...valid, price: -1 },
    { ...valid, price: 1.1 },
    { ...valid, price: Number.NaN },
    { ...valid, price: Number.POSITIVE_INFINITY },
    { ...valid, sortOrder: -1 },
    { ...valid, sortOrder: 1.5 },
    { ...valid, sortOrder: '1' },
    { ...valid, sortOrder: Number.NaN },
    { ...valid, sortOrder: Number.POSITIVE_INFINITY },
    { ...valid, sortOrder: 4_294_967_296 },
    { ...valid, image_path: '/not-allowed' },
    { ...valid, id: 1 },
  ];

  for (const falseBoolean of [1, 0, 'true', 'false', '1', '0', null, [], {}]) {
    invalidBodies.push(
      { ...valid, isAvailable: falseBoolean },
      { ...valid, isVisible: falseBoolean },
    );
  }

  for (const body of invalidBodies) {
    assert.throws(() => validateNewProduct(body), (error) => error.status === 400);
  }

  for (const value of [
    '0',
    '-1',
    '1.5',
    '12abc',
    'NaN',
    '18446744073709551616',
  ]) {
    assert.throws(() => parseProductId(value), (error) => error.status === 400);
  }

  assert.throws(() => validateProductChanges({}), (error) => error.status === 400);
});

test('updates only allowlisted columns and reloads unchanged products safely', async () => {
  const calls = [];
  const service = createAdminProductsService({
    executor: {
      async execute(sql, parameters) {
        calls.push({ sql, parameters });

        if (sql.includes('FROM categories')) {
          return [[{ id: 3 }], []];
        }

        if (sql.includes('UPDATE menu_items')) {
          return [{ affectedRows: 0, changedRows: 0 }, []];
        }

        return [[
          productRow({
            categoryId: '3',
            categoryName: 'دسر',
            description: '',
            price: '90000',
            sortOrder: 8,
            isAvailable: 0,
            isVisible: 0,
          }),
        ], []];
      },
    },
  });

  const updated = await service.update('1', {
    categoryId: 3,
    description: '',
    price: '90000',
    sortOrder: 8,
    isAvailable: false,
    isVisible: false,
  });
  const update = calls.find((call) => call.sql.includes('UPDATE menu_items'));

  assert.match(
    update.sql,
    /SET category_id = \?, description = \?, price = \?, display_order = \?, is_available = \?, is_visible = \?/,
  );
  assert.deepEqual(update.parameters, [3, '', '90000', 8, 0, 0, '1']);
  assert.equal(updated.categoryId, '3');
  assert.equal(updated.description, '');
  assert.equal(updated.isAvailable, false);
});

test('returns safe errors for missing products and missing categories', async (context) => {
  await context.test('not found update', async () => {
    const service = createAdminProductsService({
      executor: {
        async execute(sql) {
          return sql.includes('UPDATE menu_items') ? [{ affectedRows: 0 }, []] : [[], []];
        },
      },
    });

    await assert.rejects(
      service.update('7', { name: 'نام تازه' }),
      (error) => error.status === 404 && error.code === 'PRODUCT_NOT_FOUND',
    );
  });

  await context.test('missing category before create', async () => {
    const harness = createTransactionHarness({ categoryRows: [] });
    const service = createAdminProductsService({ executor: harness.pool });

    await assert.rejects(
      service.create({ categoryId: 99, name: 'قهوه', price: '100' }),
      (error) => error.status === 400 && error.code === 'INVALID_PRODUCT_CATEGORY',
    );
    assert.deepEqual(harness.events, [
      'getConnection',
      'beginTransaction',
      'selectCategory',
      'rollback',
      'release',
    ]);
    assert.equal(harness.releaseCount, 1);
  });

  await context.test('missing category before update', async () => {
    const service = createAdminProductsService({
      executor: { async execute() { return [[], []]; } },
    });

    await assert.rejects(
      service.update('7', { categoryId: 99 }),
      (error) => error.status === 400 && error.code === 'INVALID_PRODUCT_CATEGORY',
    );
  });

  await context.test('foreign-key race during category update', async () => {
    const service = createAdminProductsService({
      executor: {
        async execute(sql) {
          if (sql.includes('FROM categories')) {
            return [[{ id: 2 }], []];
          }

          throw Object.assign(new Error('sensitive FK metadata'), {
            code: 'ER_NO_REFERENCED_ROW_2',
            errno: 1452,
          });
        },
      },
    });

    await assert.rejects(
      service.update('7', { categoryId: 2 }),
      (error) =>
        error.status === 400 &&
        error.code === 'INVALID_PRODUCT_CATEGORY' &&
        error.message.includes('sensitive') === false,
    );
  });
});

test('deletes products using the driver result header and preserves unknown errors', async (context) => {
  await context.test('successful parameterized delete', async () => {
    const calls = [];
    const service = createAdminProductsService({
      executor: {
        async execute(sql, parameters) {
          calls.push({ sql, parameters });
          return [{ affectedRows: 1 }, []];
        },
      },
    });

    await service.remove('7');
    assert.deepEqual(calls, [
      { sql: 'DELETE FROM menu_items WHERE id = ?', parameters: ['7'] },
    ]);
  });

  await context.test('not found delete', async () => {
    const service = createAdminProductsService({
      executor: { async execute() { return [{ affectedRows: 0 }, []]; } },
    });

    await assert.rejects(
      service.remove('7'),
      (error) => error.status === 404 && error.code === 'PRODUCT_NOT_FOUND',
    );
  });

  await context.test('unknown database error', async () => {
    const databaseError = Object.assign(new Error('internal SQL detail'), {
      code: 'ER_LOCK_DEADLOCK',
    });
    const service = createAdminProductsService({
      executor: { async execute() { throw databaseError; } },
    });

    await assert.rejects(service.remove('7'), (error) => error === databaseError);
  });

  await context.test('does not invent a delete conflict absent from the schema', async () => {
    const databaseError = Object.assign(new Error('unexpected dependency metadata'), {
      code: 'ER_ROW_IS_REFERENCED_2',
      errno: 1451,
    });
    const service = createAdminProductsService({
      executor: { async execute() { throw databaseError; } },
    });

    await assert.rejects(service.remove('7'), (error) => error === databaseError);
  });
});
