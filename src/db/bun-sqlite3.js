const Client_BetterSQLite3 = require('knex/lib/dialects/better-sqlite3');

/**
 * knex-диалект поверх встроенного в Bun драйвера `bun:sqlite`.
 *
 * API bun:sqlite повторяет better-sqlite3, поэтому наследуем его диалект
 * и переопределяем ровно три места, где bun:sqlite отличается:
 *   1. _driver()               — конструктор лежит в именованном экспорте модуля
 *   2. acquireRawConnection()  — нельзя передавать readonly:false и пустой объект опций
 *   3. _query()                — нет statement.reader, зато есть statement.columnNames
 *
 * driverName намеренно остаётся 'better-sqlite3': от него зависит
 * FunctionHelper.uuid(), который по имени диалекта выбирает выражение для
 * db.fn.uuid(). _packageName нужен только для текста ошибки initializeDriver.
 */
class Client_BunSQLite3 extends Client_BetterSQLite3 {
  _packageName = 'bun:sqlite';

  _driver() {
    // В отличие от better-sqlite3, модуль bun:sqlite сам конструктором не является.
    return require('bun:sqlite').Database;
  }

  async acquireRawConnection() {
    const options = this.connectionSettings.options || {};
    const safeIntegers = this._optSafeIntegers(options);

    const opts = {
      // Ловушка Bun: readonly:false роняет open с "bad parameter or other API misuse".
      ...(options.readonly ? { readonly: true } : {}),
      ...(safeIntegers === undefined ? {} : { safeIntegers }),
    };

    // Вторая ловушка: даже пустой объект опций bun:sqlite не принимает.
    return Object.keys(opts).length
      ? new this.driver(this.connectionSettings.filename, opts)
      : new this.driver(this.connectionSettings.filename);
  }

  async _query(connection, obj) {
    if (!obj.sql) throw new Error('The query is empty');
    if (!connection) throw new Error('No connection provided');

    const statement = connection.prepare(obj.sql);

    const safeIntegers = this._optSafeIntegers(obj.options);
    if (safeIntegers !== undefined) statement.safeIntegers(safeIntegers);

    const bindings = this._formatBindings(obj.bindings);

    // Замена better-sqlite3 `.reader`: у SELECT/RETURNING columnNames непуст,
    // у INSERT/UPDATE/DELETE пуст. .all() на мутации вернул бы пустой массив.
    if (statement.columnNames.length > 0) {
      obj.response = statement.all(...bindings);
      return obj;
    }

    const result = statement.run(...bindings);
    obj.response = result;
    obj.context = { lastID: result.lastInsertRowid, changes: result.changes };

    return obj;
  }
}

Object.assign(Client_BunSQLite3.prototype, { driverName: 'better-sqlite3' });

/**
 * Загружает нативное расширение (sqlite-vec и т.п.) в соединение knex.
 *
 * Расширение живёт на уровне соединения, а пул sqlite у knex — ровно
 * min=1/max=1 соединение, поэтому после releaseConnection расширение
 * остаётся доступным и обычным запросам, и транзакциям.
 * Вызывать нужно один раз на каждый экземпляр knex (и повторять в каждом процессе).
 */
async function loadExtension(db, path) {
  const conn = await db.client.acquireConnection();
  try {
    conn.loadExtension(path);
  } finally {
    await db.client.releaseConnection(conn);
  }
  return db;
}

/**
 * Обёртка ради ergonomics: knex не даёт зарегистрировать строковый алиас
 * (SUPPORTED_CLIENTS в constants.js — Object.freeze), зато явно поддерживает
 * передачу конструктора диалекта. Здесь это спрятано за привычным API.
 */
function bunKnex(config) {
  const knexFactory = require('knex');
  return knexFactory({ ...config, client: Client_BunSQLite3 });
}

module.exports = Client_BunSQLite3;
module.exports.Client_BunSQLite3 = Client_BunSQLite3;
module.exports.loadExtension = loadExtension;
module.exports.bunKnex = bunKnex;
module.exports.default = Client_BunSQLite3;
