import {
  metadataStore,
  EntityClass,
  EntityMetadata,
  ColumnMetadata,
  DbRow,
} from '../mapping';
import { TypeConverter } from './type-converter';
import { IdentityMap } from './identity-map';

export interface MapOptions {
  useIdentityMap?: boolean;
  identityMap?: IdentityMap;
  prefix?: string;
}

export class ResultMapper {
  static mapRow<T>(
    entityClass: EntityClass<T>,
    row: DbRow,
    options: MapOptions = {}
  ): T {
    return this.mapRows(entityClass, [row], options)[0];
  }

  static mapRows<T>(
    entityClass: EntityClass<T>,
    rows: DbRow[],
    options: MapOptions = {}
  ): T[] {
    const meta = metadataStore.getEntityMetadataOrThrow(entityClass);
    const useIdMap = options.useIdentityMap ?? true;
    const idMap = options.identityMap || (useIdMap ? new IdentityMap() : undefined);
    const prefix = options.prefix || '';

    const results: T[] = [];
    for (const row of rows) {
      const entity = this.mapSingleRow(entityClass, meta, row, prefix, idMap);
      results.push(entity);
    }
    return results;
  }

  private static mapSingleRow<T>(
    entityClass: EntityClass<T>,
    meta: EntityMetadata,
    row: DbRow,
    prefix: string,
    idMap?: IdentityMap
  ): T {
    const pkProperties = meta.primaryKeys;
    const pkValues: Record<string, any> = {};
    for (const pkProp of pkProperties) {
      const col = meta.columns.get(pkProp)!;
      const dbVal = row[prefix + col.columnName];
      if (dbVal !== undefined) {
        pkValues[pkProp] = TypeConverter.fromDb(dbVal, col.type);
      }
    }

    if (idMap && Object.keys(pkValues).length > 0) {
      const id = idMap.buildIdentity(pkProperties, pkValues);
      const existing = idMap.get(entityClass, id);
      if (existing) return existing;
    }

    const entity = new entityClass() as Record<string, any>;

    for (const [propKey, col] of meta.columns.entries()) {
      const dbKey = prefix + col.columnName;
      if (dbKey in row) {
        entity[propKey] = TypeConverter.fromDb(row[dbKey], col.type);
      }
    }

    if (idMap && Object.keys(pkValues).length > 0) {
      const id = idMap.buildIdentity(pkProperties, pkValues);
      idMap.set(entityClass, id, entity as T);
    }

    return entity as T;
  }

  static mapJoinedRows<T>(
    entityClass: EntityClass<T>,
    rows: DbRow[],
    options: {
      identityMap?: IdentityMap;
      joins?: Array<{
        propertyKey: string;
        entityClass: EntityClass;
        alias: string;
        collection?: boolean;
      }>;
    } = {}
  ): T[] {
    const meta = metadataStore.getEntityMetadataOrThrow(entityClass);
    const idMap = options.identityMap || new IdentityMap();
    const joins = options.joins || [];

    const mainResults: Map<string, T> = new Map();
    const joinedMaps: Map<string, Map<string, any>> = new Map();

    for (const j of joins) {
      joinedMaps.set(j.propertyKey, new Map());
    }

    for (const row of rows) {
      const mainEntity = this.mapSingleRow(entityClass, meta, row, '', idMap);
      const mainPk = idMap.buildIdentity(meta.primaryKeys, mainEntity as any);
      if (!mainResults.has(mainPk)) {
        mainResults.set(mainPk, mainEntity);
        for (const j of joins) {
          if (j.collection) {
            (mainEntity as any)[j.propertyKey] = [];
          }
        }
      }

      for (const j of joins) {
        const jMeta = metadataStore.getEntityMetadataOrThrow(j.entityClass);
        const hasData = this.rowHasData(row, jMeta, j.alias + '_');
        if (!hasData) continue;

        const jEntity = this.mapSingleRow(j.entityClass, jMeta, row, j.alias + '_', idMap);
        const jPk = idMap.buildIdentity(jMeta.primaryKeys, jEntity as any);
        const jMap = joinedMaps.get(j.propertyKey)!;

        if (!jMap.has(jPk)) {
          jMap.set(jPk, jEntity);
        }
        const stored = jMap.get(jPk)!;

        const storedMain = mainResults.get(mainPk)!;
        if (j.collection) {
          const arr = (storedMain as any)[j.propertyKey] as any[];
          if (!arr.find((x) => idMap.buildIdentity(jMeta.primaryKeys, x as any) === jPk)) {
            arr.push(stored);
          }
        } else {
          (storedMain as any)[j.propertyKey] = stored;
        }
      }
    }

    return Array.from(mainResults.values());
  }

  private static rowHasData(
    row: DbRow,
    meta: EntityMetadata,
    prefix: string
  ): boolean {
    for (const pk of meta.primaryKeys) {
      const col = meta.columns.get(pk);
      if (col && row[prefix + col.columnName] != null) {
        return true;
      }
    }
    return false;
  }

  static getEntityId(entity: any, entityClass: EntityClass): string | undefined {
    const meta = metadataStore.getEntityMetadata(entityClass);
    if (!meta || meta.primaryKeys.length === 0) return undefined;
    const pkProps = meta.primaryKeys;
    if (pkProps.length === 1) {
      return String((entity as any)[pkProps[0]]);
    }
    return pkProps.map((pk) => String((entity as any)[pk])).join('::');
  }

  static extractPrimaryKeyValues<T>(
    entity: T,
    entityClass: EntityClass<T>
  ): Record<string, any> {
    const meta = metadataStore.getEntityMetadataOrThrow(entityClass);
    const result: Record<string, any> = {};
    const obj = entity as Record<string, any>;
    for (const pk of meta.primaryKeys) {
      const col = meta.columns.get(pk);
      if (col) {
        result[col.columnName] = obj[pk];
      }
    }
    return result;
  }

  static extractChangedColumns<T>(
    original: T,
    current: T,
    entityClass: EntityClass<T>
  ): Record<string, any> {
    const meta = metadataStore.getEntityMetadataOrThrow(entityClass);
    const changes: Record<string, any> = {};
    const orig = original as Record<string, any>;
    const curr = current as Record<string, any>;

    for (const [propKey, col] of meta.columns.entries()) {
      if (col.isPrimaryKey) continue;
      const origVal = orig[propKey];
      const currVal = curr[propKey];
      if (!this.valuesEqual(origVal, currVal)) {
        changes[col.columnName] = TypeConverter.toDb(currVal, col.type);
      }
    }
    return changes;
  }

  private static valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  }
}
