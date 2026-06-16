export type ColumnType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'json'
  | 'text';

export interface ColumnMetadata {
  propertyKey: string;
  columnName: string;
  type: ColumnType;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  isNullable: boolean;
  defaultValue?: any;
}

export type RelationType = 'one-to-many' | 'many-to-one' | 'many-to-many';

export interface RelationMetadata {
  propertyKey: string;
  type: RelationType;
  targetEntity: () => Function;
  foreignKey?: string;
  joinTable?: string;
  joinColumn?: string;
  inverseJoinColumn?: string;
  mappedBy?: string;
  isLazy: boolean;
}

export interface EntityMetadata {
  target: Function;
  entityName: string;
  tableName: string;
  columns: Map<string, ColumnMetadata>;
  primaryKeys: string[];
  relations: Map<string, RelationMetadata>;
}

export interface EntityClass<T = any> {
  new (...args: any[]): T;
}

export type DbRow = Record<string, any>;
