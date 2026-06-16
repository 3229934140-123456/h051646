export type WhereOperator =
  | '='
  | '!='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='
  | 'LIKE'
  | 'NOT LIKE'
  | 'IN'
  | 'NOT IN'
  | 'IS NULL'
  | 'IS NOT NULL'
  | 'BETWEEN';

export type LogicOperator = 'AND' | 'OR';

export interface WhereCondition {
  column: string;
  operator: WhereOperator;
  value?: any;
  value2?: any;
  logic?: LogicOperator;
}

export interface OrderByItem {
  column: string;
  direction: 'ASC' | 'DESC';
}

export interface JoinItem {
  type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
  table: string;
  alias?: string;
  on: string;
  params?: any[];
}

export interface QueryResult {
  sql: string;
  params: any[];
}

export interface BuiltQuery extends QueryResult {
  type: 'select' | 'insert' | 'update' | 'delete' | 'count';
}

export type SelectColumn = string | { expression: string; alias: string };
