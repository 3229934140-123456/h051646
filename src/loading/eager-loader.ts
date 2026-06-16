import {
  metadataStore,
  EntityClass,
  EntityMetadata,
  RelationMetadata,
  DbRow,
} from '../mapping';
import { QueryBuilder } from '../query';
import { ResultMapper } from '../result';
import { IdentityMap } from '../result';
import { DbDriver } from './db-driver';

export interface EagerLoadOptions {
  relations: string[];
}

interface EagerPlan {
  propertyPath: string;
  relation: RelationMetadata;
  ownerClass: EntityClass;
  targetClass: EntityClass;
  alias: string;
  parentAlias?: string;
}

export class EagerLoader {
  static buildEagerQuery<T>(
    entityClass: EntityClass<T>,
    options: EagerLoadOptions,
    baseQuery?: QueryBuilder<T>
  ): { query: QueryBuilder<T>; plans: EagerPlan[] } {
    const meta = metadataStore.getEntityMetadataOrThrow(entityClass);
    const plans: EagerPlan[] = [];
    const query = baseQuery || QueryBuilder.forEntity(entityClass).alias('root');

    let aliasCounter = 0;
    const nextAlias = () => `e${++aliasCounter}`;

    for (const relPath of options.relations) {
      const plan = this.resolveRelationPath(entityClass, relPath, nextAlias);
      if (plan) plans.push(plan);
    }

    const columns: Array<string | { expression: string; alias: string }> = ['root.*'];
    for (const plan of plans) {
      const targetMeta = metadataStore.getEntityMetadataOrThrow(plan.targetClass);
      for (const [, col] of targetMeta.columns.entries()) {
        columns.push({
          expression: `${plan.alias}.${col.columnName}`,
          alias: `${plan.alias}_${col.columnName}`,
        });
      }
    }
    query.select(...columns);

    for (const plan of plans) {
      const targetMeta = metadataStore.getEntityMetadataOrThrow(plan.targetClass);
      const targetTable = targetMeta.tableName;
      const targetPkCol = targetMeta.columns.get(targetMeta.primaryKeys[0])!.columnName;
      const ownerMeta = metadataStore.getEntityMetadataOrThrow(plan.ownerClass);
      const ownerAlias = plan.parentAlias || 'root';

      let onClause: string;

      switch (plan.relation.type) {
        case 'many-to-one': {
          let fkCol: string;
          if (plan.relation.foreignKey) {
            fkCol = plan.relation.foreignKey;
          } else if (ownerMeta.columns.has(plan.propertyPath)) {
            fkCol = ownerMeta.columns.get(plan.propertyPath)!.columnName;
          } else {
            fkCol = plan.propertyPath + '_id';
          }
          onClause = `${ownerAlias}.${fkCol} = ${plan.alias}.${targetPkCol}`;
          break;
        }

        case 'one-to-many': {
          const inverseMeta = targetMeta;
          const mappedBy = plan.relation.mappedBy!;
          const inverseRel = inverseMeta.relations.get(mappedBy);

          let fkColumn: string;
          if (inverseRel?.foreignKey) {
            fkColumn = inverseRel.foreignKey;
          } else {
            const ownerPkProp = ownerMeta.primaryKeys[0];
            fkColumn = metadataStore.getColumnName(plan.ownerClass, ownerPkProp);
            if (!fkColumn.includes('_id')) {
              fkColumn = ownerMeta.tableName.replace(/s$/, '') + '_id';
            }
          }
          const ownerPkCol = ownerMeta.columns.get(ownerMeta.primaryKeys[0])!.columnName;
          onClause = `${ownerAlias}.${ownerPkCol} = ${plan.alias}.${fkColumn}`;
          break;
        }

        case 'many-to-many': {
          const joinTable = plan.relation.joinTable ||
            this.getDefaultJoinTableName(ownerMeta, targetMeta);
          const joinColumn = plan.relation.joinColumn ||
            ownerMeta.tableName.replace(/s$/, '') + '_id';
          const inverseJoinColumn = plan.relation.inverseJoinColumn ||
            targetMeta.tableName.replace(/s$/, '') + '_id';
          const ownerPkCol = ownerMeta.columns.get(ownerMeta.primaryKeys[0])!.columnName;
          const jtAlias = `${plan.alias}_jt`;

          query.leftJoin(
            joinTable,
            `${ownerAlias}.${ownerPkCol} = ${jtAlias}.${joinColumn}`,
            jtAlias
          );
          onClause = `${jtAlias}.${inverseJoinColumn} = ${plan.alias}.${targetPkCol}`;
          break;
        }

        default:
          continue;
      }

      query.leftJoin(targetTable, onClause, plan.alias);
    }

    return { query, plans };
  }

  static async executeEagerQuery<T>(
    entityClass: EntityClass<T>,
    driver: DbDriver,
    options: EagerLoadOptions,
    baseQuery?: QueryBuilder<T>,
    identityMap?: IdentityMap
  ): Promise<T[]> {
    const { query, plans } = this.buildEagerQuery(entityClass, options, baseQuery);
    const built = query.buildSelect();
    const rows = await driver.query<DbRow>(built.sql, built.params);

    const idMap = identityMap || new IdentityMap();

    const joins = plans.map((p) => ({
      propertyKey: p.propertyPath,
      entityClass: p.targetClass,
      alias: p.alias,
      collection: p.relation.type === 'one-to-many' || p.relation.type === 'many-to-many',
    }));

    const results = ResultMapper.mapJoinedRows(entityClass, rows, {
      identityMap: idMap,
      joins,
    });

    return results;
  }

  private static resolveRelationPath(
    entityClass: EntityClass,
    path: string,
    nextAlias: () => string,
    parentAlias?: string
  ): EagerPlan | null {
    const parts = path.split('.');
    let currentClass = entityClass;
    let currentAlias = parentAlias;

    for (let i = 0; i < parts.length; i++) {
      const propName = parts[i];
      const meta = metadataStore.getEntityMetadata(currentClass);
      if (!meta) return null;

      const rel = meta.relations.get(propName);
      if (!rel) return null;

      const alias = nextAlias();
      const targetClass = rel.targetEntity() as EntityClass;

      if (i === parts.length - 1) {
        return {
          propertyPath: propName,
          relation: rel,
          ownerClass: currentClass,
          targetClass,
          alias,
          parentAlias: currentAlias,
        };
      }

      currentClass = targetClass;
      currentAlias = alias;
    }
    return null;
  }

  private static getDefaultJoinTableName(
    ownerMeta: EntityMetadata,
    targetMeta: EntityMetadata
  ): string {
    const names = [ownerMeta.tableName, targetMeta.tableName].sort();
    return names.join('_');
  }
}
