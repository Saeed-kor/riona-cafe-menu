import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAdminCategoriesService,
  parseCategoryId,
  validateCategoryChanges,
  validateNewCategory,
} from '../src/services/adminCategories.service.js';

const timestamp = new Date('2026-08-04T12:00:00.000Z');

function categoryRow(overrides = {}) {
  return {
    id: 1,
    name: 'نوشیدنی گرم',
    sortOrder: 2,
    isVisible: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

test('lists categories in display order and maps the public contract', async () => {
  const calls = [];
  const service = createAdminCategoriesService({
    executor: {
      async execute(sql, parameters) {
        calls.push({ sql, parameters });
        return [[categoryRow()], []];
      },
    },
  });

  const categories = await service.list();

  assert.match(calls[0].sql, /ORDER BY display_order ASC, id ASC/);
  assert.equal(calls[0].parameters, undefined);
  assert.deepEqual(categories, [
    {
      id: '1',
      name: 'نوشیدنی گرم',
      sortOrder: 2,
      isVisible: true,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    },
  ]);
});

test('creates a trimmed category with parameterized values', async () => {
  const calls = [];
  const injectedName = "  چای', is_visible = 0 --  ";
  const service = createAdminCategoriesService({
    executor: {
      async execute(sql, parameters) {
        calls.push({ sql, parameters });

        if (sql.includes('INSERT INTO categories')) {
          return [{ insertId: 9 }, []];
        }

        return [[categoryRow({ id: 9, name: injectedName.trim(), sortOrder: 4 })], []];
      },
    },
  });

  const category = await service.create({
    name: injectedName,
    sortOrder: 4,
    isVisible: true,
  });
  const insert = calls[0];

  assert.equal(insert.sql.includes(injectedName.trim()), false);
  assert.deepEqual(insert.parameters, [injectedName.trim(), 4, 1]);
  assert.equal(category.id, '9');
});

test('validates create and update bodies without coercing booleans or sort order', () => {
  assert.deepEqual(validateNewCategory({ name: '  قهوه  ' }), {
    name: 'قهوه',
    sortOrder: 0,
    isVisible: true,
  });
  assert.deepEqual(validateCategoryChanges({ isVisible: false, sortOrder: 0 }), {
    sortOrder: 0,
    isVisible: false,
  });
  assert.equal(parseCategoryId('18446744073709551615'), '18446744073709551615');

  for (const body of [
    { name: '   ' },
    { name: 'a'.repeat(101) },
    { name: 'چای', sortOrder: -1 },
    { name: 'چای', sortOrder: 1.5 },
    { name: 'چای', isVisible: 1 },
    { name: 'چای', unexpected: true },
  ]) {
    assert.throws(() => validateNewCategory(body), (error) => error.status === 400);
  }

  assert.throws(() => validateCategoryChanges({}), (error) => error.status === 400);
  assert.throws(() => parseCategoryId('0'), (error) => error.status === 400);
  assert.throws(
    () => parseCategoryId('18446744073709551616'),
    (error) => error.status === 400,
  );
});

test('maps collation duplicate errors to a safe 409 response error', async () => {
  const databaseError = Object.assign(new Error('internal duplicate detail'), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });
  const service = createAdminCategoriesService({
    executor: {
      async execute(sql) {
        if (sql.includes('INSERT INTO categories')) {
          throw databaseError;
        }

        throw new Error(`Unexpected SQL in duplicate test: ${sql}`);
      },
    },
  });

  await assert.rejects(
    service.create({ name: 'قهوه' }),
    (error) =>
      error.status === 409 &&
      error.code === 'CATEGORY_NAME_CONFLICT' &&
      error.message.includes('internal duplicate detail') === false,
  );
});

test('updates only fixed columns with parameters and reloads unchanged rows safely', async () => {
  const calls = [];
  const service = createAdminCategoriesService({
    executor: {
      async execute(sql, parameters) {
        calls.push({ sql, parameters });

        if (sql.includes('UPDATE categories')) {
          return [{ affectedRows: 0 }, []];
        }

        return [[categoryRow({ name: 'قهوه سرد', sortOrder: 8, isVisible: 0 })], []];
      },
    },
  });

  const updated = await service.update('1', {
    name: ' قهوه سرد ',
    sortOrder: 8,
    isVisible: false,
  });

  assert.match(calls[0].sql, /SET name = \?, display_order = \?, is_visible = \?/);
  assert.deepEqual(calls[0].parameters, ['قهوه سرد', 8, 0, '1']);
  assert.equal(updated.isVisible, false);
  assert.equal(updated.sortOrder, 8);
});

test('returns safe not-found and dependent-category delete errors', async (context) => {
  await context.test('successful parameterized delete', async () => {
    const calls = [];
    const service = createAdminCategoriesService({
      executor: {
        async execute(sql, parameters) {
          calls.push({ sql, parameters });
          return [{ affectedRows: 1 }, []];
        },
      },
    });

    await service.remove('7');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql, 'DELETE FROM categories WHERE id = ?');
    assert.deepEqual(calls[0].parameters, ['7']);
  });

  await context.test('not found update', async () => {
    const service = createAdminCategoriesService({
      executor: {
        async execute(sql) {
          return sql.includes('UPDATE categories') ? [{ affectedRows: 0 }, []] : [[], []];
        },
      },
    });

    await assert.rejects(
      service.update('7', { name: 'نام تازه' }),
      (error) => error.status === 404 && error.code === 'CATEGORY_NOT_FOUND',
    );
  });

  await context.test('not found delete', async () => {
    const service = createAdminCategoriesService({
      executor: { async execute() { return [{ affectedRows: 0 }, []]; } },
    });

    await assert.rejects(
      service.remove('7'),
      (error) => error.status === 404 && error.code === 'CATEGORY_NOT_FOUND',
    );
  });

  await context.test('category with menu items', async () => {
    const service = createAdminCategoriesService({
      executor: {
        async execute() {
          throw Object.assign(new Error('foreign key details'), {
            code: 'ER_ROW_IS_REFERENCED_2',
            errno: 1451,
          });
        },
      },
    });

    await assert.rejects(
      service.remove('7'),
      (error) =>
        error.status === 409 &&
        error.code === 'CATEGORY_HAS_MENU_ITEMS' &&
        error.message.includes('foreign key details') === false,
    );
  });
});
