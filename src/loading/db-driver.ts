import { DbRow } from '../mapping';
import { BuiltQuery } from '../query';

export interface DbDriver {
  query<T extends DbRow = DbRow>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<{ rowCount: number; rows: DbRow[] }>;
  executeBatch(statements: Array<{ sql: string; params?: any[] }>): Promise<Array<{ rowCount: number; rows: DbRow[] }>>;
}

export class MemoryDbDriver implements DbDriver {
  private tables: Map<string, DbRow[]> = new Map();
  private autoIncrement: Map<string, number> = new Map();
  private queryLog: Array<{ sql: string; params: any[] }> = [];
  private enableNPlusOneDetection = false;
  private queryPatterns: Map<string, number> = new Map();
  private nPlusOneThreshold = 3;

  setNPlusOneDetection(enabled: boolean, threshold: number = 3): void {
    this.enableNPlusOneDetection = enabled;
    this.nPlusOneThreshold = threshold;
  }

  getQueryLog(): Array<{ sql: string; params: any[] }> {
    return [...this.queryLog];
  }

  clearQueryLog(): void {
    this.queryLog = [];
    this.queryPatterns.clear();
  }

  createTable(name: string): void {
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
      this.autoIncrement.set(name, 1);
    }
  }

  insertData(table: string, rows: DbRow[]): void {
    this.createTable(table);
    const data = this.tables.get(table)!;
    for (const row of rows) {
      const newRow = { ...row };
      if (newRow.id === undefined || newRow.id === null) {
        newRow.id = this.autoIncrement.get(table)!;
        this.autoIncrement.set(table, newRow.id + 1);
      } else {
        this.autoIncrement.set(table, Math.max(this.autoIncrement.get(table)!, newRow.id + 1));
      }
      data.push(newRow);
    }
  }

  async query<T extends DbRow = DbRow>(sql: string, params: any[] = []): Promise<T[]> {
    this.queryLog.push({ sql, params });
    if (this.enableNPlusOneDetection) {
      this.checkNPlusOne(sql);
    }
    return this.executeSelect(sql, params) as T[];
  }

  async execute(sql: string, params: any[] = []): Promise<{ rowCount: number; rows: DbRow[] }> {
    this.queryLog.push({ sql, params });
    if (sql.trim().toUpperCase().startsWith('INSERT')) {
      return this.executeInsert(sql, params);
    } else if (sql.trim().toUpperCase().startsWith('UPDATE')) {
      return this.executeUpdate(sql, params);
    } else if (sql.trim().toUpperCase().startsWith('DELETE')) {
      return this.executeDelete(sql, params);
    } else {
      const rows = this.executeSelect(sql, params);
      return { rowCount: rows.length, rows };
    }
  }

  async executeBatch(
    statements: Array<{ sql: string; params?: any[] }>
  ): Promise<Array<{ rowCount: number; rows: DbRow[] }>> {
    const results: Array<{ rowCount: number; rows: DbRow[] }> = [];
    for (const stmt of statements) {
      results.push(await this.execute(stmt.sql, stmt.params || []));
    }
    return results;
  }

  private normalizePattern(sql: string): string {
    return sql
      .replace(/\$\d+/g, '?')
      .replace(/IN\s*\([^)]+\)/gi, 'IN (?)')
      .replace(/BETWEEN\s+\S+\s+AND\s+\S+/gi, 'BETWEEN ? AND ?')
      .replace(/LIMIT\s+\d+/gi, 'LIMIT ?')
      .replace(/OFFSET\s+\d+/gi, 'OFFSET ?')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private checkNPlusOne(sql: string): void {
    if (!sql.trim().toUpperCase().startsWith('SELECT')) return;
    const pattern = this.normalizePattern(sql);
    const count = (this.queryPatterns.get(pattern) || 0) + 1;
    this.queryPatterns.set(pattern, count);
    if (count >= this.nPlusOneThreshold) {
      console.warn(
        `[N+1 WARNING] Query pattern executed ${count} times, possible N+1 problem:\n${sql.substring(0, 200)}`
      );
    }
  }

  private executeSelect(sql: string, params: any[]): DbRow[] {
    const joinCount = (sql.match(/JOIN/gi) || []).length;
    if (joinCount >= 2) {
      const result = this.parseMultiJoinSelect(sql, params);
      if (result) return result;
    }
    if (joinCount === 1) {
      const joinMatch = this.parseJoinSelect(sql, params);
      if (joinMatch) return joinMatch;
    }

    const match = sql.match(
      /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+AS\s+(\w+))?(.*?)(?:\s+LIMIT\s+\$?(\d+))?(?:\s+OFFSET\s+\$?(\d+))?\s*$/i
    );
    if (!match) {
      return [];
    }

    const [, columns, table, , restClause, limitStr, offsetStr] = match;
    const { whereClause, orderBy, groupBy } = this.extractClauses(restClause || '');

    const data = this.tables.get(table) || [];
    let filtered = this.applyWhere(data, whereClause, params);

    if (groupBy) {
      filtered = this.applyGroupBy(filtered, groupBy, columns);
    }

    if (orderBy) {
      filtered = this.applyOrderBy(filtered, orderBy);
    }

    if (offsetStr) {
      const offset = parseInt(offsetStr);
      if (!isNaN(offset)) filtered = filtered.slice(offset);
    }
    if (limitStr) {
      const limit = parseInt(limitStr);
      if (!isNaN(limit)) filtered = filtered.slice(0, limit);
    }

    if (columns.trim() === '*' || columns.trim().includes('.*')) {
      return filtered.map((r) => ({ ...r }));
    }

    const colNames = columns.split(',').map((c) => c.trim());
    return filtered.map((r) => {
      const result: DbRow = {};
      for (const col of colNames) {
        const aliasMatch = col.match(/(.+?)\s+AS\s+(\w+)$/i);
        if (aliasMatch) {
          const [, expr, alias] = aliasMatch;
          if (expr.includes('COUNT') || expr.includes('count')) {
            result[alias] = filtered.length;
          } else {
            result[alias] = r[expr.trim()];
          }
        } else {
          result[col] = r[col];
        }
      }
      return result;
    });
  }

  private parseMultiJoinSelect(sql: string, params: any[]): DbRow[] | null {
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s*/i);
    if (!selectMatch) return null;

    let [, columns, mainTable, mainAlias] = selectMatch;
    const keywords = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'WHERE', 'ON', 'GROUP', 'ORDER', 'LIMIT', 'HAVING']);
    if (mainAlias && keywords.has(mainAlias.toUpperCase())) mainAlias = '';
    const resolvedMainAlias = mainAlias || mainTable;
    const mainData = this.tables.get(mainTable) || [];

    const joinRegex = /(LEFT|INNER|RIGHT)\s+JOIN\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s+ON\s+([\w.]+\s*=\s*[\w.]+)/gi;
    const joins: Array<{
      type: string;
      table: string;
      alias: string;
      onLeft: string;
      onRight: string;
    }> = [];

    let joinMatch;
    while ((joinMatch = joinRegex.exec(sql)) !== null) {
      let [, jType, jTable, jAlias, onClause] = joinMatch;
      if (jAlias && keywords.has(jAlias.toUpperCase())) jAlias = '';
      const alias = jAlias || jTable;
      const onParts = onClause.split('=').map((s: string) => s.trim());
      joins.push({
        type: jType.toUpperCase(),
        table: jTable,
        alias,
        onLeft: onParts[0],
        onRight: onParts[1],
      });
    }

    if (joins.length === 0) return null;

    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+GROUP|\s+ORDER|\s+LIMIT|\s*$)/i);
    const whereClause = whereMatch ? whereMatch[1].trim() : null;

    let results: DbRow[] = mainData.map((row) => {
      const combined: DbRow = {};
      for (const [k, v] of Object.entries(row)) {
        combined[k] = v;
        combined[`${resolvedMainAlias}_${k}`] = v;
      }
      return combined;
    });

    for (const join of joins) {
      const joinData = this.tables.get(join.table) || [];
      const newResults: DbRow[] = [];

      const resolveOnCol = (onStr: string, row: DbRow): { alias: string; col: string; val: any } => {
        if (onStr.includes('.')) {
          const [a, c] = onStr.split('.');
          return { alias: a, col: c, val: row[`${a}_${c}`] ?? row[c] };
        }
        return { alias: '', col: onStr, val: row[onStr] };
      };

      for (const resultRow of results) {
        const leftOn = resolveOnCol(join.onLeft, resultRow);
        const rightOn = resolveOnCol(join.onRight, resultRow);

        let lookupVal: any;
        let resultCol: string;

        if (leftOn.alias === join.alias) {
          resultCol = leftOn.col;
          lookupVal = resultRow[`${rightOn.alias}_${rightOn.col}`] ?? resultRow[rightOn.col];
        } else if (rightOn.alias === join.alias) {
          resultCol = rightOn.col;
          lookupVal = resultRow[`${leftOn.alias}_${leftOn.col}`] ?? resultRow[leftOn.col];
        } else if (leftOn.val === undefined) {
          resultCol = leftOn.col;
          lookupVal = resultRow[`${rightOn.alias}_${rightOn.col}`] ?? resultRow[rightOn.col];
        } else {
          resultCol = rightOn.col;
          lookupVal = resultRow[`${leftOn.alias}_${leftOn.col}`] ?? resultRow[leftOn.col];
        }

        const matched = joinData.filter((jr) => jr[resultCol] === lookupVal);

        if (matched.length === 0 && join.type === 'LEFT') {
          const combined = { ...resultRow };
          if (joinData.length > 0) {
            for (const k of Object.keys(joinData[0])) {
              combined[`${join.alias}_${k}`] = null;
            }
          }
          newResults.push(combined);
        } else {
          for (const jRow of matched) {
            const combined = { ...resultRow };
            for (const [k, v] of Object.entries(jRow)) {
              combined[`${join.alias}_${k}`] = v;
            }
            newResults.push(combined);
          }
        }
      }

      results = newResults;
    }

    if (whereClause) {
      results = this.applyWhere(results, whereClause, params);
    }

    return results;
  }

  private parseJoinSelect(sql: string, params: any[]): DbRow[] | null {
    const joinPattern =
      /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s+(LEFT|INNER|RIGHT)\s+JOIN\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?\s+ON\s+(.+?)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+\$?(\d+))?\s*$/i;
    const m = sql.match(joinPattern);
    if (!m) return null;

    let [, columns, mainTable, mainAlias, joinType, joinTable, joinAlias, onCond, where, groupBy, orderBy, limitStr] = m;
    const keywords = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'WHERE', 'ON', 'GROUP', 'ORDER', 'LIMIT', 'HAVING']);
    if (mainAlias && keywords.has(mainAlias.toUpperCase())) mainAlias = '';
    if (joinAlias && keywords.has(joinAlias.toUpperCase())) joinAlias = '';
    const mainData = this.tables.get(mainTable) || [];
    const joinData = this.tables.get(joinTable) || [];

    const onMatch = onCond.match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);
    if (!onMatch) return null;
    const [, t1, c1, t2, c2] = onMatch;
    const resolvedMainAlias = mainAlias || mainTable;
    const resolvedJoinAlias = joinAlias || joinTable;
    const leftCol = t1 === resolvedMainAlias ? c1 : c2;
    const rightCol = t2 === resolvedJoinAlias ? c2 : c1;

    let results: DbRow[] = [];
    for (const mainRow of mainData) {
      const matched = joinData.filter((jr) => jr[rightCol] === mainRow[leftCol]);
      if (matched.length === 0 && joinType.toUpperCase() === 'LEFT') {
        const combined: DbRow = {};
        for (const [k, v] of Object.entries(mainRow)) {
          combined[k] = v;
          combined[`${resolvedMainAlias}_${k}`] = v;
        }
        for (const k of Object.keys(joinData[0] || {})) {
          combined[`${resolvedJoinAlias}_${k}`] = null;
        }
        results.push(combined);
      } else {
        for (const jRow of matched) {
          const combined: DbRow = {};
          for (const [k, v] of Object.entries(mainRow)) {
            combined[k] = v;
            combined[`${resolvedMainAlias}_${k}`] = v;
          }
          for (const [k, v] of Object.entries(jRow)) {
            combined[`${resolvedJoinAlias}_${k}`] = v;
          }
          results.push(combined);
        }
      }
    }

    if (where) {
      results = this.applyWhere(results, where, params);
    }

    if (groupBy) {
      results = this.applyGroupBy(results, groupBy, columns);
    }

    if (orderBy) {
      results = this.applyOrderBy(results, orderBy);
    }

    if (limitStr) {
      const limit = parseInt(limitStr);
      if (!isNaN(limit)) results = results.slice(0, limit);
    }

    return results;
  }

  private applyWhere(data: DbRow[], whereClause: string, params: any[]): DbRow[] {
    if (!whereClause || !whereClause.trim()) return data;
    let cleaned = whereClause.replace(/^\s*WHERE\s+/i, '').trim();
    let paramIdx = 0;
    const replaceParam = () => {
      const v = params[paramIdx++];
      if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
      if (v === null || v === undefined) return 'NULL';
      return String(v);
    };
    cleaned = cleaned.replace(/\$\d+/g, () => replaceParam());

    const conditions = this.splitConditions(cleaned);

    return data.filter((row) => this.evaluateConditions(row, conditions));
  }

  private splitConditions(expr: string): Array<{ logic?: string; cond: string }> {
    const result: Array<{ logic?: string; cond: string }> = [];
    const parts = expr.split(/\s+(AND|OR)\s+/i);
    if (parts.length === 1) {
      result.push({ cond: parts[0].trim() });
    } else {
      result.push({ cond: parts[0].trim() });
      for (let i = 1; i < parts.length; i += 2) {
        result.push({ logic: parts[i].toUpperCase(), cond: parts[i + 1]?.trim() || '' });
      }
    }
    return result;
  }

  private evaluateConditions(row: DbRow, conditions: Array<{ logic?: string; cond: string }>): boolean {
    if (conditions.length === 0) return true;
    let result = this.evaluateSingleCondition(row, conditions[0].cond);
    for (let i = 1; i < conditions.length; i++) {
      const c = conditions[i];
      const val = this.evaluateSingleCondition(row, c.cond);
      if (c.logic === 'OR') result = result || val;
      else result = result && val;
    }
    return result;
  }

  private evaluateSingleCondition(row: DbRow, cond: string): boolean {
    const inMatch = cond.match(/([\w.]+)\s+(NOT\s+)?IN\s*\((.+?)\)\s*$/i);
    if (inMatch) {
      const [, col, not, valuesStr] = inMatch;
      const values = valuesStr.split(',').map((v) => {
        const s = v.trim();
        if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
        if (s === 'NULL') return null;
        const n = parseFloat(s);
        return isNaN(n) ? s : n;
      });
      const rowVal = this.getRowValue(row, col);
      const inList = values.some((v) => this.valuesEqual(v, rowVal));
      return not ? !inList : inList;
    }

    const nullMatch = cond.match(/([\w.]+)\s+IS\s+(NOT\s+)?NULL\s*$/i);
    if (nullMatch) {
      const [, col, not] = nullMatch;
      const val = this.getRowValue(row, col);
      return not ? val !== null : val === null;
    }

    const betweenMatch = cond.match(/([\w.]+)\s+BETWEEN\s+(.+?)\s+AND\s+(.+?)\s*$/i);
    if (betweenMatch) {
      const [, col, minStr, maxStr] = betweenMatch;
      const val = this.getRowValue(row, col);
      const min = this.parseValue(minStr);
      const max = this.parseValue(maxStr);
      return val >= min && val <= max;
    }

    const likeMatch = cond.match(/([\w.]+)\s+(NOT\s+)?LIKE\s+'(.+?)'\s*$/i);
    if (likeMatch) {
      const [, col, not, pattern] = likeMatch;
      const val = String(this.getRowValue(row, col) ?? '');
      const regex = new RegExp(
        '^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$',
        'i'
      );
      return not ? !regex.test(val) : regex.test(val);
    }

    const opMatch = cond.match(/([\w.]+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+?)\s*$/);
    if (opMatch) {
      const [, col, op, valStr] = opMatch;
      const rowVal = this.getRowValue(row, col);
      const cmpVal = this.parseValue(valStr);
      switch (op) {
        case '=':
          return this.valuesEqual(rowVal, cmpVal);
        case '!=':
        case '<>':
          return !this.valuesEqual(rowVal, cmpVal);
        case '<':
          return (rowVal as number) < (cmpVal as number);
        case '<=':
          return (rowVal as number) <= (cmpVal as number);
        case '>':
          return (rowVal as number) > (cmpVal as number);
        case '>=':
          return (rowVal as number) >= (cmpVal as number);
      }
    }
    return true;
  }

  private getRowValue(row: DbRow, col: string): any {
    if (col.includes('.')) {
      const parts = col.split('.');
      const tablePart = parts[0];
      const colPart = parts[1];
      if (row[colPart] !== undefined) return row[colPart];
      const prefixed = `${tablePart}_${colPart}`;
      return row[prefixed];
    }
    return row[col];
  }

  private parseValue(s: string): any {
    const str = s.trim();
    if (str === 'NULL') return null;
    if (str.startsWith("'") && str.endsWith("'")) return str.slice(1, -1);
    const n = parseFloat(str);
    if (!isNaN(n) && /^-?\d+(\.\d+)?$/.test(str)) return n;
    return str;
  }

  private extractClauses(rest: string): {
    whereClause: string;
    orderBy: string | null;
    groupBy: string | null;
  } {
    let s = rest;
    let whereClause = '';
    let orderBy: string | null = null;
    let groupBy: string | null = null;

    const orderIdx = s.search(/\s+ORDER\s+BY\s+/i);
    if (orderIdx !== -1) {
      orderBy = s.slice(orderIdx).replace(/^\s+ORDER\s+BY\s+/i, '').trim();
      s = s.slice(0, orderIdx);
    }

    const groupIdx = s.search(/\s+GROUP\s+BY\s+/i);
    if (groupIdx !== -1) {
      groupBy = s.slice(groupIdx).replace(/^\s+GROUP\s+BY\s+/i, '').trim();
      s = s.slice(0, groupIdx);
    }

    if (s.trim()) {
      whereClause = s.trim();
    }

    return { whereClause, orderBy, groupBy };
  }

  private applyOrderBy(data: DbRow[], orderBy: string): DbRow[] {
    const items = orderBy.split(',').map((item) => {
      const trimmed = item.trim();
      const parts = trimmed.split(/\s+/);
      const col = parts[0];
      const dir = (parts[1] || 'ASC').toUpperCase();
      return { col, dir };
    });

    return [...data].sort((a, b) => {
      for (const { col, dir } of items) {
        const va = this.getRowValue(a, col);
        const vb = this.getRowValue(b, col);
        let cmp = 0;
        if (va === null || va === undefined) cmp = vb === null || vb === undefined ? 0 : -1;
        else if (vb === null || vb === undefined) cmp = 1;
        else if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
        else cmp = String(va).localeCompare(String(vb));
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  }

  private applyGroupBy(data: DbRow[], groupBy: string, columns: string): DbRow[] {
    const groupCols = groupBy.split(',').map((c) => c.trim());
    const groups: Map<string, DbRow[]> = new Map();

    for (const row of data) {
      const key = groupCols.map((c) => String(this.getRowValue(row, c))).join('|||');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    const result: DbRow[] = [];
    for (const [, rows] of groups) {
      const agg: DbRow = { ...rows[0] };
      const colItems = columns.split(',').map((c) => c.trim());
      for (const col of colItems) {
        const aliasMatch = col.match(/(.+?)\s+AS\s+(\w+)$/i);
        if (aliasMatch) {
          const [, expr, alias] = aliasMatch;
          const exprUp = expr.toUpperCase();
          if (exprUp.startsWith('COUNT')) agg[alias] = rows.length;
          else if (exprUp.startsWith('AVG')) {
            const inner = expr.match(/AVG\s*\(\s*([^)]+)\s*\)/i);
            if (inner) {
              const avgCol = inner[1].trim();
              const nums = rows.map((r) => Number(this.getRowValue(r, avgCol))).filter((n) => !isNaN(n));
              agg[alias] = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
            }
          } else if (exprUp.startsWith('SUM')) {
            const inner = expr.match(/SUM\s*\(\s*([^)]+)\s*\)/i);
            if (inner) {
              const sumCol = inner[1].trim();
              const nums = rows.map((r) => Number(this.getRowValue(r, sumCol))).filter((n) => !isNaN(n));
              agg[alias] = nums.reduce((a, b) => a + b, 0);
            }
          } else {
            agg[alias] = this.getRowValue(rows[0], expr.trim());
          }
        }
      }
      result.push(agg);
    }
    return result;
  }

  private valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return String(a) === String(b);
  }

  private executeInsert(sql: string, params: any[]): { rowCount: number; rows: DbRow[] } {
    const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\((.+?)\)\s*VALUES\s*\((.+?)\)/i);
    if (!match) return { rowCount: 0, rows: [] };
    const [, table, colsStr, valsStr] = match;
    this.createTable(table);
    const columns = colsStr.split(',').map((c) => c.trim());
    const values = valsStr.split(',').map((v) => v.trim());
    const row: DbRow = {};
    let pIdx = 0;
    for (let i = 0; i < columns.length; i++) {
      const v = values[i];
      if (v.startsWith('$')) {
        row[columns[i]] = params[pIdx++];
      } else if (v.startsWith("'") && v.endsWith("'")) {
        row[columns[i]] = v.slice(1, -1);
      } else if (v === 'NULL') {
        row[columns[i]] = null;
      } else {
        const n = parseFloat(v);
        row[columns[i]] = isNaN(n) ? v : n;
      }
    }
    if (!row.id) {
      row.id = this.autoIncrement.get(table)!;
      this.autoIncrement.set(table, row.id + 1);
    } else {
      this.autoIncrement.set(table, Math.max(this.autoIncrement.get(table)!, row.id + 1));
    }
    this.tables.get(table)!.push(row);
    return { rowCount: 1, rows: [{ ...row }] };
  }

  private executeUpdate(sql: string, params: any[]): { rowCount: number; rows: DbRow[] } {
    const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+?))?(?:\s+RETURNING\s+\*)?\s*$/i);
    if (!match) return { rowCount: 0, rows: [] };
    const [, table, setStr, whereClause] = match;
    const data = this.tables.get(table);
    if (!data) return { rowCount: 0, rows: [] };

    const setClauses = setStr.split(',').map((c) => c.trim());
    const updates: Array<{ col: string; value: any }> = [];
    let pIdx = 0;
    for (const clause of setClauses) {
      const m = clause.match(/(\w+)\s*=\s*(.+)/);
      if (m) {
        const [, col, val] = m;
        if (val.startsWith('$')) {
          updates.push({ col, value: params[pIdx++] });
        } else if (val.startsWith("'") && val.endsWith("'")) {
          updates.push({ col, value: val.slice(1, -1) });
        } else if (val === 'NULL') {
          updates.push({ col, value: null });
        } else {
          const n = parseFloat(val);
          updates.push({ col, value: isNaN(n) ? val : n });
        }
      }
    }

    const filtered = this.applyWhere(data, whereClause || '', params.slice(pIdx));
    for (const row of filtered) {
      for (const u of updates) {
        row[u.col] = u.value;
      }
    }
    return { rowCount: filtered.length, rows: filtered.map((r) => ({ ...r })) };
  }

  private executeDelete(sql: string, params: any[]): { rowCount: number; rows: DbRow[] } {
    const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+RETURNING\s+\*)?\s*$/i);
    if (!match) return { rowCount: 0, rows: [] };
    const [, table, whereClause] = match;
    const data = this.tables.get(table);
    if (!data) return { rowCount: 0, rows: [] };

    const deleted: DbRow[] = [];
    const remaining: DbRow[] = [];
    if (!whereClause) {
      deleted.push(...data);
      data.length = 0;
    } else {
      const filtered = this.applyWhere(data, whereClause, params);
      const deleteIds = new Set(filtered.map((r) => r.id));
      for (const row of data) {
        if (deleteIds.has(row.id)) deleted.push(row);
        else remaining.push(row);
      }
      data.length = 0;
      data.push(...remaining);
    }
    return { rowCount: deleted.length, rows: deleted.map((r) => ({ ...r })) };
  }
}
