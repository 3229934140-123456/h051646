import { ColumnType } from '../mapping';

export class TypeConverter {
  static fromDb(value: any, type: ColumnType): any {
    if (value === null || value === undefined) return null;

    switch (type) {
      case 'string':
      case 'text':
        return String(value);

      case 'number':
        if (typeof value === 'number') return value;
        const n = Number(value);
        return isNaN(n) ? null : n;

      case 'boolean':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
          const s = value.toLowerCase();
          return s === 'true' || s === '1' || s === 'yes' || s === 't';
        }
        return !!value;

      case 'date':
        if (value instanceof Date) return value;
        if (typeof value === 'string' || typeof value === 'number') {
          const d = new Date(value);
          return isNaN(d.getTime()) ? null : d;
        }
        return null;

      case 'json':
        if (typeof value === 'string') {
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        }
        return value;

      default:
        return value;
    }
  }

  static toDb(value: any, type: ColumnType): any {
    if (value === null || value === undefined) return null;

    switch (type) {
      case 'string':
      case 'text':
        return String(value);

      case 'number':
        return Number(value);

      case 'boolean':
        return value ? true : false;

      case 'date':
        if (value instanceof Date) {
          return value.toISOString();
        }
        return new Date(value as any).toISOString();

      case 'json':
        if (typeof value === 'string') return value;
        return JSON.stringify(value);

      default:
        return value;
    }
  }

  static entityToRow<T>(
    entity: T,
    columns: Map<string, { columnName: string; type: ColumnType }>
  ): Record<string, any> {
    const row: Record<string, any> = {};
    const entityObj = entity as Record<string, any>;

    for (const [propKey, colMeta] of columns.entries()) {
      if (propKey in entityObj) {
        const value = entityObj[propKey];
        if (value !== undefined) {
          row[colMeta.columnName] = this.toDb(value, colMeta.type);
        }
      }
    }
    return row;
  }

  static entityToRowExcludingAutoIncrement<T>(
    entity: T,
    columns: Map<string, { columnName: string; type: ColumnType; isAutoIncrement: boolean }>
  ): Record<string, any> {
    const row: Record<string, any> = {};
    const entityObj = entity as Record<string, any>;

    for (const [propKey, colMeta] of columns.entries()) {
      if (colMeta.isAutoIncrement) continue;
      if (propKey in entityObj) {
        const value = entityObj[propKey];
        if (value !== undefined) {
          row[colMeta.columnName] = this.toDb(value, colMeta.type);
        }
      }
    }
    return row;
  }
}
