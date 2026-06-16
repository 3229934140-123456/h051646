import 'reflect-metadata';
import {
  EntityMetadata,
  ColumnMetadata,
  RelationMetadata,
  EntityClass,
} from './types';

export class MetadataStore {
  private static instance: MetadataStore;
  private entities: Map<Function, EntityMetadata> = new Map();

  private constructor() {}

  static getInstance(): MetadataStore {
    if (!MetadataStore.instance) {
      MetadataStore.instance = new MetadataStore();
    }
    return MetadataStore.instance;
  }

  registerEntity(target: Function, tableName?: string): void {
    if (!this.entities.has(target)) {
      this.entities.set(target, {
        target,
        entityName: target.name,
        tableName: tableName || this.snakeCase(target.name),
        columns: new Map(),
        primaryKeys: [],
        relations: new Map(),
      });
    } else if (tableName) {
      const meta = this.entities.get(target)!;
      meta.tableName = tableName;
    }
  }

  registerColumn(
    target: Function,
    propertyKey: string,
    column: Partial<ColumnMetadata>
  ): void {
    this.ensureEntity(target);
    const meta = this.entities.get(target)!;
    const columnName = column.columnName || this.snakeCase(propertyKey);
    const existing = meta.columns.get(propertyKey) || {
      propertyKey,
      columnName,
      type: 'string',
      isPrimaryKey: false,
      isAutoIncrement: false,
      isNullable: true,
    };
    const merged: ColumnMetadata = { ...existing, ...column, columnName };
    meta.columns.set(propertyKey, merged);
    if (merged.isPrimaryKey && !meta.primaryKeys.includes(propertyKey)) {
      meta.primaryKeys.push(propertyKey);
    }
  }

  registerRelation(
    target: Function,
    propertyKey: string,
    relation: Partial<RelationMetadata> & {
      type: RelationMetadata['type'];
      targetEntity: () => Function;
    }
  ): void {
    this.ensureEntity(target);
    const meta = this.entities.get(target)!;
    const existing = meta.relations.get(propertyKey);

    const reflectJoinTable = Reflect.getMetadata(`orm:joinTable:${propertyKey}`, target);
    const reflectJoinColumn = Reflect.getMetadata(`orm:joinColumn:${propertyKey}`, target);

    const merged: RelationMetadata = {
      propertyKey,
      type: relation.type,
      targetEntity: relation.targetEntity,
      foreignKey: relation.foreignKey || reflectJoinColumn,
      joinTable: relation.joinTable || reflectJoinTable,
      joinColumn: relation.joinColumn || reflectJoinColumn,
      inverseJoinColumn: relation.inverseJoinColumn,
      mappedBy: relation.mappedBy,
      isLazy: relation.isLazy ?? true,
      ...(existing || {}),
    };
    meta.relations.set(propertyKey, merged);
  }

  getEntityMetadata<T>(target: EntityClass<T>): EntityMetadata | undefined {
    return this.entities.get(target);
  }

  getEntityMetadataOrThrow<T>(target: EntityClass<T>): EntityMetadata {
    const meta = this.entities.get(target);
    if (!meta) {
      throw new Error(`Entity ${target.name} is not registered`);
    }
    return meta;
  }

  getColumnByProperty<T>(
    target: EntityClass<T>,
    propertyKey: string
  ): ColumnMetadata | undefined {
    return this.getEntityMetadata(target)?.columns.get(propertyKey);
  }

  getColumnName<T>(target: EntityClass<T>, propertyKey: string): string {
    const col = this.getColumnByProperty(target, propertyKey);
    return col?.columnName || this.snakeCase(propertyKey);
  }

  getTableName<T>(target: EntityClass<T>): string {
    return this.getEntityMetadata(target)?.tableName || this.snakeCase(target.name);
  }

  getPrimaryKeyColumns<T>(target: EntityClass<T>): string[] {
    const meta = this.getEntityMetadata(target);
    if (!meta) return ['id'];
    return meta.primaryKeys.map((pk) => meta.columns.get(pk)!.columnName);
  }

  getPrimaryKeyProperties<T>(target: EntityClass<T>): string[] {
    return this.getEntityMetadata(target)?.primaryKeys || ['id'];
  }

  private ensureEntity(target: Function): void {
    if (!this.entities.has(target)) {
      this.registerEntity(target);
    }
  }

  snakeCase(str: string): string {
    return str
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase();
  }
}

export const metadataStore = MetadataStore.getInstance();
