import {
  metadataStore,
  EntityClass,
  EntityMetadata,
  RelationMetadata,
  DbRow,
} from '../mapping';
import { DbDriver } from './db-driver';
import { QueryBuilder } from '../query';
import { ResultMapper } from '../result';
import { IdentityMap } from '../result';

export interface LazyLoadContext {
  driver: DbDriver;
  identityMap: IdentityMap;
}

export function createLazyProxy<T extends object>(
  target: T,
  propertyKey: string,
  relation: RelationMetadata,
  context: LazyLoadContext,
  ownerEntity: any,
  ownerClass: EntityClass
): T {
  let loaded = false;
  let cache: any;
  let loading = false;

  const load = async (): Promise<any> => {
    if (loaded) return cache;
    if (loading) return cache;
    loading = true;

    try {
      const targetClass = relation.targetEntity() as EntityClass;
      const targetMeta = metadataStore.getEntityMetadataOrThrow(targetClass);
      const ownerMeta = metadataStore.getEntityMetadataOrThrow(ownerClass);

      switch (relation.type) {
        case 'many-to-one': {
          const fkProp = relation.mappedBy || relation.foreignKey ||
            targetMeta.primaryKeys[0];
          const fkCol = relation.foreignKey ||
            (ownerMeta.columns.has(fkProp)
              ? ownerMeta.columns.get(fkProp)!.columnName
              : fkProp);

          const ownerObj = ownerEntity as Record<string, any>;
          let fkValue: any;
          if (ownerMeta.columns.has(fkProp)) {
            fkValue = ownerObj[fkProp];
          } else {
            const targetPkCol = targetMeta.columns.get(targetMeta.primaryKeys[0])!.columnName;
            fkValue = ownerObj[targetPkCol];
          }

          if (!fkValue) {
            cache = null;
            loaded = true;
            return cache;
          }

          const qb = QueryBuilder.forEntity(targetClass).alias('t');
          const targetPkCol = targetMeta.columns.get(targetMeta.primaryKeys[0])!.columnName;
          qb.where(`t.${targetPkCol}`, '=', fkValue);
          const built = qb.buildSelect();
          const rows = await context.driver.query<DbRow>(built.sql, built.params);
          cache = rows.length > 0
            ? ResultMapper.mapRow(targetClass, rows[0], { identityMap: context.identityMap })
            : null;
          break;
        }

        case 'one-to-many': {
          const inverseClass = targetClass;
          const inverseMeta = metadataStore.getEntityMetadataOrThrow(inverseClass);
          const mappedBy = relation.mappedBy!;
          const inverseRel = inverseMeta.relations.get(mappedBy);

          let fkColumn: string;
          if (inverseRel?.foreignKey) {
            fkColumn = inverseRel.foreignKey;
          } else {
            const ownerPkProp = ownerMeta.primaryKeys[0];
            fkColumn = metadataStore.getColumnName(ownerClass, ownerPkProp);
            fkColumn = fkColumn.replace('id', '_id');
            if (!fkColumn.endsWith('_id')) fkColumn = fkColumn + '_id';
          }
          if (!fkColumn.includes('_')) {
            fkColumn = ownerMeta.tableName.replace(/s$/, '') + '_id';
          }

          const ownerPk = ownerMeta.primaryKeys[0];
          const ownerPkVal = (ownerEntity as Record<string, any>)[ownerPk];

          const qb = QueryBuilder.forEntity(inverseClass).alias('t');
          qb.where(`t.${fkColumn}`, '=', ownerPkVal);
          const built = qb.buildSelect();
          const rows = await context.driver.query<DbRow>(built.sql, built.params);
          cache = ResultMapper.mapRows(inverseClass, rows, { identityMap: context.identityMap });
          break;
        }

        case 'many-to-many': {
          const joinTable = relation.joinTable ||
            getDefaultJoinTableName(ownerMeta, targetMeta);
          const joinColumn = relation.joinColumn ||
            ownerMeta.tableName.replace(/s$/, '') + '_id';
          const inverseJoinColumn = relation.inverseJoinColumn ||
            targetMeta.tableName.replace(/s$/, '') + '_id';

          const ownerPk = ownerMeta.primaryKeys[0];
          const ownerPkVal = (ownerEntity as Record<string, any>)[ownerPk];

          const targetPkCol = targetMeta.columns.get(targetMeta.primaryKeys[0])!.columnName;
          const targetTable = targetMeta.tableName;

          const sql = `SELECT t.* FROM ${targetTable} t ` +
            `INNER JOIN ${joinTable} jt ON t.${targetPkCol} = jt.${inverseJoinColumn} ` +
            `WHERE jt.${joinColumn} = $1`;

          const rows = await context.driver.query<DbRow>(sql, [ownerPkVal]);
          cache = ResultMapper.mapRows(targetClass, rows, { identityMap: context.identityMap });
          break;
        }
      }

      loaded = true;
      return cache;
    } finally {
      loading = false;
    }
  };

  Object.defineProperty(target, propertyKey, {
    get() {
      if (!loaded) {
        const promise = load();
        const thenable = promise as any;
        thenable.then = promise.then.bind(promise);
        thenable.catch = promise.catch.bind(promise);
        return thenable;
      }
      return cache;
    },
    set(value: any) {
      cache = value;
      loaded = true;
    },
    configurable: true,
    enumerable: true,
  });

  return target;
}

function getDefaultJoinTableName(
  ownerMeta: EntityMetadata,
  targetMeta: EntityMetadata
): string {
  const names = [ownerMeta.tableName, targetMeta.tableName].sort();
  return names.join('_');
}

export function applyLazyLoading<T extends object>(
  entity: T,
  entityClass: EntityClass<T>,
  context: LazyLoadContext
): T {
  const meta = metadataStore.getEntityMetadata(entityClass);
  if (!meta) return entity;

  const entityObj = entity as Record<string, any>;
  for (const [propKey, rel] of meta.relations.entries()) {
    if (rel.isLazy) {
      const currentValue = entityObj[propKey];
      if (currentValue === undefined || currentValue === null) {
        createLazyProxy(entity, propKey, rel, context, entity, entityClass);
      }
    }
  }
  return entity;
}
