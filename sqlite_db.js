const Database = require('better-sqlite3');

function createSqliteDatabase(filename) {
  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  const execute = async (sql, params = []) => {
    if (!Array.isArray(params) || params.length === 0) {
      const statements = String(sql).split(';').map((statement) => statement.trim()).filter(Boolean);
      if (statements.length > 1) {
        database.exec(sql);
        return [{ affectedRows: 0, insertId: 0 }];
      }
    }
    const statement = database.prepare(sql);
    const normalizedParams = Array.isArray(params) ? params : [];
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
      return [statement.all(...normalizedParams)];
    }
    const result = statement.run(...normalizedParams);
    return [{
      affectedRows: result.changes,
      insertId: Number(result.lastInsertRowid),
    }];
  };

  return {
    execute,
    query: execute,
    async getConnection() {
      return {
        execute,
        beginTransaction: async () => database.exec('BEGIN'),
        commit: async () => database.exec('COMMIT'),
        rollback: async () => database.exec('ROLLBACK'),
        release: () => {},
      };
    },
    close: () => database.close(),
  };
}

module.exports = { createSqliteDatabase };
