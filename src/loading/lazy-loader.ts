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
          const ownerObj = ownerEntity as Record<string, any>;
          const fkValue = resolveManyToOneFkValue(relation, ownerMeta, targetMeta, ownerObj);

          if (fkValue === null || fkValue === undefined) {
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
          const fkColumn = resolveOneToManyFkColumn(relation, ownerMeta, inverseMeta);

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
        return load().then((result: any) => {
          return result;
        });
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

function resolveManyToOneFkValue(
  relation: RelationMetadata,
  ownerMeta: EntityMetadata,
  targetMeta: EntityMetadata,
  ownerObj: Record<string, any>
): any {
  if (relation.foreignKey) {
    const col = ownerMeta.columns.get(relation.foreignKey);
    if (col && ownerObj[relation.foreignKey] !== undefined) {
      return ownerObj[relation.foreignKey];
    }
    for (const [propKey, c] of ownerMeta.columns.entries()) {
      if (c.columnName === relation.foreignKey) {
        return ownerObj[propKey];
      }
    }
    return ownerObj[relation.foreignKey];
  }

  const targetName = relation.propertyKey;
  const candidateProp = targetName + 'Id';
  if (ownerMeta.columns.has(candidateProp)) {
    return ownerObj[candidateProp];
  }

  const candidateCol = metadataStore.snakeCase(targetName) + '_id';
  for (const [propKey, col] of ownerMeta.columns.entries()) {
    if (col.columnName === candidateCol) {
      return ownerObj[propKey];
    }
  }

  for (const [propKey, col] of ownerMeta.columns.entries()) {
    if (col.columnName.endsWith('_id')) {
      return ownerObj[propKey];
    }
  }

  return ownerObj[ownerMeta.primaryKeys[0]];
}

function resolveOneToManyFkColumn(
  relation: RelationMetadata,
  ownerMeta: EntityMetadata,
  inverseMeta: EntityMetadata
): string {
  if (relation.mappedBy) {
    const inverseRel = inverseMeta.relations.get(relation.mappedBy);
    if (inverseRel?.foreignKey) {
      const col = inverseMeta.columns.get(inverseRel.foreignKey);
      if (col) return col.columnName;
      return inverseRel.foreignKey;
    }

    const candidateProp = relation.mappedBy + 'Id';
    if (inverseMeta.columns.has(candidateProp)) {
      return inverseMeta.columns.get(candidateProp)!.columnName;
    }

    const candidateCol = metadataStore.snakeCase(relation.mappedBy) + '_id';
    for (const [, col] of inverseMeta.columns.entries()) {
      if (col.columnName === candidateCol) {
        return col.columnName;
      }
    }

    for (const [, col] of inverseMeta.columns.entries()) {
      if (col.columnName.endsWith('_id')) {
        return col.columnName;
      }
    }
  }

  const ownerTableName = ownerMeta.tableName;
  const singular = ownerTableName.replace(/s$/, '');
  const candidateCol = singular + '_id';
  for (const [, col] of inverseMeta.columns.entries()) {
    if (col.columnName === candidateCol) {
      return col.columnName;
    }
  }

  for (const [, col] of inverseMeta.columns.entries()) {
    if (col.columnName.endsWith('_id')) {
      return col.columnName;
    }
  }

  return candidateCol;
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
