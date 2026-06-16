import { metadataStore, EntityClass } from '../mapping';
import {
  WhereCondition,
  WhereOperator,
  LogicOperator,
  OrderByItem,
  JoinItem,
  QueryResult,
  SelectColumn,
  BuiltQuery,
} from './types';

export class QueryBuilder<T = any> {
  private entityClass: EntityClass<T> | null = null;
  private tableName: string;
  private tableAlias: string | null = null;
  private columns: SelectColumn[] = [];
  private joins: JoinItem[] = [];
  private whereConditions: WhereCondition[] = [];
  private groupByColumns: string[] = [];
  private havingConditions: WhereCondition[] = [];
  private orderByItems: OrderByItem[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private params: any[] = [];
  private paramIndex = 1;

  constructor(tableName?: string, entityClass?: EntityClass<T>) {
    this.tableName = tableName || '';
    this.entityClass = entityClass || null;
  }

  static forEntity<T>(entityClass: EntityClass<T>): QueryBuilder<T> {
    const tableName = metadataStore.getTableName(entityClass);
    return new QueryBuilder<T>(tableName, entityClass);
  }

  static forTable(tableName: string): QueryBuilder {
    return new QueryBuilder(tableName);
  }

  select(...columns: SelectColumn[]): this {
    this.columns = columns;
    return this;
  }

  addSelect(...columns: SelectColumn[]): this {
    this.columns.push(...columns);
    return this;
  }

  from(table: string, alias?: string): this {
    this.tableName = table;
    this.tableAlias = alias || null;
    return this;
  }

  alias(a: string): this {
    this.tableAlias = a;
    return this;
  }

  join(
    type: JoinItem['type'],
    table: string,
    on: string,
    alias?: string,
    params: any[] = []
  ): this {
    this.joins.push({ type, table, alias, on, params });
    this.params.push(...params);
    return this;
  }

  innerJoin(table: string, on: string, alias?: string, params?: any[]): this {
    return this.join('INNER', table, on, alias, params);
  }

  leftJoin(table: string, on: string, alias?: string, params?: any[]): this {
    return this.join('LEFT', table, on, alias, params);
  }

  rightJoin(table: string, on: string, alias?: string, params?: any[]): this {
    return this.join('RIGHT', table, on, alias, params);
  }

  where(
    column: string,
    operator: WhereOperator,
    value?: any,
    logic: LogicOperator = 'AND'
  ): this {
    const cond: WhereCondition = { column, operator, logic };
    if (operator !== 'IS NULL' && operator !== 'IS NOT NULL') {
      cond.value = value;
    }
    if (this.whereConditions.length === 0) {
      cond.logic = undefined;
    }
    this.whereConditions.push(cond);
    return this;
  }

  andWhere(column: string, operator: WhereOperator, value?: any): this {
    return this.where(column, operator, value, 'AND');
  }

  orWhere(column: string, operator: WhereOperator, value?: any): this {
    return this.where(column, operator, value, 'OR');
  }

  whereEq(column: string, value: any, logic: LogicOperator = 'AND'): this {
    return this.where(column, '=', value, logic);
  }

  andWhereEq(column: string, value: any): this {
    return this.whereEq(column, value, 'AND');
  }

  orWhereEq(column: string, value: any): this {
    return this.whereEq(column, value, 'OR');
  }

  whereIn(column: string, values: any[], logic: LogicOperator = 'AND'): this {
    return this.where(column, 'IN', values, logic);
  }

  andWhereIn(column: string, values: any[]): this {
    return this.whereIn(column, values, 'AND');
  }

  orWhereIn(column: string, values: any[]): this {
    return this.whereIn(column, values, 'OR');
  }

  whereBetween(
    column: string,
    min: any,
    max: any,
    logic: LogicOperator = 'AND'
  ): this {
    const cond: WhereCondition = {
      column,
      operator: 'BETWEEN',
      value: min,
      value2: max,
      logic,
    };
    if (this.whereConditions.length === 0) {
      cond.logic = undefined;
    }
    this.whereConditions.push(cond);
    return this;
  }

  whereIsNull(column: string, logic: LogicOperator = 'AND'): this {
    return this.where(column, 'IS NULL', undefined, logic);
  }

  whereIsNotNull(column: string, logic: LogicOperator = 'AND'): this {
    return this.where(column, 'IS NOT NULL', undefined, logic);
  }

  whereLike(column: string, pattern: string, logic: LogicOperator = 'AND'): this {
    return this.where(column, 'LIKE', pattern, logic);
  }

  groupBy(...columns: string[]): this {
    this.groupByColumns.push(...columns);
    return this;
  }

  having(
    column: string,
    operator: WhereOperator,
    value?: any,
    logic: LogicOperator = 'AND'
  ): this {
    const cond: WhereCondition = { column, operator, value, logic };
    if (this.havingConditions.length === 0) {
      cond.logic = undefined;
    }
    this.havingConditions.push(cond);
    return this;
  }

  orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    this.orderByItems.push({ column, direction });
    return this;
  }

  limit(n: number): this {
    this.limitValue = n;
    return this;
  }

  offset(n: number): this {
    this.offsetValue = n;
    return this;
  }

  page(pageNum: number, pageSize: number): this {
    this.limitValue = pageSize;
    this.offsetValue = (pageNum - 1) * pageSize;
    return this;
  }

  buildSelect(): BuiltQuery {
    const params: any[] = [];
    let pIdx = 1;

    const pushParam = (v: any): string => {
      params.push(v);
      return `$${pIdx++}`;
    };

    const colList =
      this.columns.length > 0
        ? this.columns
            .map((c) =>
              typeof c === 'string' ? this.qualify(c) : `${c.expression} AS ${c.alias}`
            )
            .join(', ')
        : this.qualify('*');

    let sql = `SELECT ${colList} FROM ${this.tableName}`;
    if (this.tableAlias) sql += ` AS ${this.tableAlias}`;

    for (const j of this.joins) {
      sql += ` ${j.type} JOIN ${j.table}`;
      if (j.alias) sql += ` AS ${j.alias}`;
      sql += ` ON ${j.on}`;
      if (j.params) params.push(...j.params);
    }

    const whereSql = this.buildConditions(this.whereConditions, pushParam);
    if (whereSql) sql += ` WHERE ${whereSql}`;

    if (this.groupByColumns.length > 0) {
      sql += ` GROUP BY ${this.groupByColumns.map((c) => this.qualify(c)).join(', ')}`;
    }

    const havingSql = this.buildConditions(this.havingConditions, pushParam);
    if (havingSql) sql += ` HAVING ${havingSql}`;

    if (this.orderByItems.length > 0) {
      sql += ` ORDER BY ${this.orderByItems
        .map((o) => `${this.qualify(o.column)} ${o.direction}`)
        .join(', ')}`;
    }

    if (this.limitValue !== null) {
      sql += ` LIMIT $${pIdx++}`;
      params.push(this.limitValue);
    }
    if (this.offsetValue !== null) {
      sql += ` OFFSET $${pIdx++}`;
      params.push(this.offsetValue);
    }

    return { type: 'select', sql, params };
  }

  buildCount(countColumn: string = '*'): BuiltQuery {
    const originalColumns = this.columns;
    this.columns = [{ expression: `COUNT(${countColumn})`, alias: 'count' }];
    const result = this.buildSelect();
    this.columns = originalColumns;
    return { ...result, type: 'count' };
  }

  buildInsert(data: Record<string, any>): BuiltQuery {
    const columns: string[] = [];
    const placeholders: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      const colName = this.entityClass
        ? metadataStore.getColumnName(this.entityClass, key)
        : key;
      columns.push(colName);
      placeholders.push(`$${pIdx++}`);
      params.push(this.serializeValue(value));
    }

    const sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    return { type: 'insert', sql, params };
  }

  buildUpdate(data: Record<string, any>): BuiltQuery {
    const setClauses: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      const colName = this.entityClass
        ? metadataStore.getColumnName(this.entityClass, key)
        : key;
      setClauses.push(`${colName} = $${pIdx++}`);
      params.push(this.serializeValue(value));
    }

    let sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')}`;

    const pushParam = (v: any): string => {
      params.push(v);
      return `$${pIdx++}`;
    };
    const whereSql = this.buildConditions(this.whereConditions, pushParam);
    if (whereSql) sql += ` WHERE ${whereSql}`;

    sql += ' RETURNING *';
    return { type: 'update', sql, params };
  }

  buildDelete(): BuiltQuery {
    const params: any[] = [];
    let pIdx = 1;

    const pushParam = (v: any): string => {
      params.push(v);
      return `$${pIdx++}`;
    };

    let sql = `DELETE FROM ${this.tableName}`;
    const whereSql = this.buildConditions(this.whereConditions, pushParam);
    if (whereSql) sql += ` WHERE ${whereSql}`;
    sql += ' RETURNING *';
    return { type: 'delete', sql, params };
  }

  private buildConditions(
    conditions: WhereCondition[],
    pushParam: (v: any) => string
  ): string {
    if (conditions.length === 0) return '';
    return conditions
      .map((cond, i) => {
        let expr = '';
        const col = this.qualify(cond.column);
        switch (cond.operator) {
          case 'IS NULL':
          case 'IS NOT NULL':
            expr = `${col} ${cond.operator}`;
            break;
          case 'IN':
          case 'NOT IN': {
            const values = Array.isArray(cond.value) ? cond.value : [cond.value];
            const placeholders = values.map((v) => pushParam(v)).join(', ');
            expr = `${col} ${cond.operator} (${placeholders})`;
            break;
          }
          case 'BETWEEN':
            expr = `${col} BETWEEN ${pushParam(cond.value)} AND ${pushParam(cond.value2)}`;
            break;
          default:
            expr = `${col} ${cond.operator} ${pushParam(cond.value)}`;
        }
        const prefix = i === 0 ? '' : `${cond.logic || 'AND'} `;
        return `${prefix}${expr}`;
      })
      .join(' ');
  }

  private qualify(column: string): string {
    if (!this.tableAlias) return column;
    if (column === '*') return `${this.tableAlias}.*`;
    if (column.includes('.') || column.includes('(')) return column;
    return `${this.tableAlias}.${column}`;
  }

  private serializeValue(value: any): any {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return value;
  }

  getTableName(): string {
    return this.tableName;
  }

  getEntityClass(): EntityClass<T> | null {
    return this.entityClass;
  }
}
