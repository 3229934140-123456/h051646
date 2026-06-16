import 'reflect-metadata';
import { metadataStore } from './metadata-store';
import { ColumnType, RelationType, EntityClass } from './types';

export interface EntityOptions {
  name?: string;
  table?: string;
}

export function Entity(options?: EntityOptions): ClassDecorator {
  return function (target: Function) {
    metadataStore.registerEntity(target, options?.table || options?.name);
  };
}

export interface ColumnOptions {
  name?: string;
  type?: ColumnType;
  nullable?: boolean;
  default?: any;
}

export function Column(options?: ColumnOptions): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    const designType = Reflect.getMetadata('design:type', target, propertyKey);
    let type: ColumnType = 'string';
    if (designType === Number) type = 'number';
    else if (designType === Boolean) type = 'boolean';
    else if (designType === Date) type = 'date';
    else if (designType === Object || designType === Array) type = 'json';

    metadataStore.registerColumn(target.constructor, key, {
      columnName: options?.name,
      type: options?.type || type,
      isNullable: options?.nullable ?? true,
      defaultValue: options?.default,
    });
  };
}

export interface PrimaryKeyOptions {
  name?: string;
  autoIncrement?: boolean;
}

export function PrimaryKey(options?: PrimaryKeyOptions): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    metadataStore.registerColumn(target.constructor, key, {
      columnName: options?.name,
      type: 'number',
      isPrimaryKey: true,
      isAutoIncrement: options?.autoIncrement ?? true,
      isNullable: false,
    });
  };
}

export interface ManyToOneOptions {
  foreignKey?: string;
  lazy?: boolean;
}

export function ManyToOne<T>(
  targetEntity: () => { new (...args: any[]): T },
  options?: ManyToOneOptions
): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    metadataStore.registerRelation(target.constructor, key, {
      type: 'many-to-one',
      targetEntity,
      foreignKey: options?.foreignKey,
      isLazy: options?.lazy ?? true,
    });
  };
}

export interface OneToManyOptions {
  mappedBy: string;
  lazy?: boolean;
}

export function OneToMany<T>(
  targetEntity: () => { new (...args: any[]): T },
  options: OneToManyOptions
): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    metadataStore.registerRelation(target.constructor, key, {
      type: 'one-to-many',
      targetEntity,
      mappedBy: options.mappedBy,
      isLazy: options.lazy ?? true,
    });
  };
}

export interface ManyToManyOptions {
  joinTable?: string;
  joinColumn?: string;
  inverseJoinColumn?: string;
  lazy?: boolean;
}

export function ManyToMany<T>(
  targetEntity: () => { new (...args: any[]): T },
  options?: ManyToManyOptions
): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    metadataStore.registerRelation(target.constructor, key, {
      type: 'many-to-many',
      targetEntity,
      joinTable: options?.joinTable,
      joinColumn: options?.joinColumn,
      inverseJoinColumn: options?.inverseJoinColumn,
      isLazy: options?.lazy ?? true,
    });
  };
}

export function JoinColumn(name: string): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    Reflect.defineMetadata(`orm:joinColumn:${key}`, name, target.constructor);
    const meta = metadataStore.getEntityMetadata(target.constructor as EntityClass<unknown>);
    if (meta && meta.relations.has(key)) {
      const rel = meta.relations.get(key)!;
      rel.joinColumn = name;
      rel.foreignKey = name;
    }
  };
}

export function JoinTable(name: string): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    const key = String(propertyKey);
    Reflect.defineMetadata(`orm:joinTable:${key}`, name, target.constructor);
    const meta = metadataStore.getEntityMetadata(target.constructor as EntityClass<unknown>);
    if (meta && meta.relations.has(key)) {
      const rel = meta.relations.get(key)!;
      rel.joinTable = name;
    }
  };
}
