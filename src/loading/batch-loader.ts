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

export interface BatchLoadContext {
  driver: DbDriver;
  identityMap: IdentityMap;
}

export class BatchLoader {
  static async loadRelations<T extends object>(
    entities: T[],
    relationPaths: string[],
    context: BatchLoadContext
  ): Promise<void> {
    if (!entities || entities.length === 0) return;
    const firstEntity = entities[0] as Record<string, any>;
    const entityClass = firstEntity.constructor as EntityClass<T>;

    for (const path of relationPaths) {
      await this.loadOnePath(entities, entityClass, path, context);
    }
  }

  private static async loadOnePath<T extends object>(
    entities: T[],
    entityClass: EntityClass<T>,
    path: string,
    context: BatchLoadContext
  ): Promise<void> {
    const meta = metadataStore.getEntityMetadataOrThrow(entityClass);
    const rel = meta.relations.get(path);
    if (!rel) {
      const available = Array.from(meta.relations.keys()).join(', ');
      throw new Error(
        `[ORM] Relation '${path}' not found on entity '${meta.entityName}'. Available relations: ${available || '(none)'}`
      );
    }
    const targetClass = rel.targetEntity() as EntityClass;
    const targetMeta = metadataStore.getEntityMetadataOrThrow(targetClass);

    switch (rel.type) {
      case 'many-to-one':
        await this.loadManyToOne(entities, meta, rel, targetMeta, context);
        break;
      case 'one-to-many':
        await this.loadOneToMany(entities, meta, rel, targetMeta, context);
        break;
      case 'many-to-many':
        await this.loadManyToMany(entities, meta, rel, targetMeta, context);
        break;
    }
  }

  private static async loadManyToOne<T extends object>(
    entities: T[],
    ownerMeta: EntityMetadata,
    rel: RelationMetadata,
    targetMeta: EntityMetadata,
    context: BatchLoadContext
  ): Promise<void> {
    const ownerRecords = entities as Array<Record<string, any>>;
    const fkValues: any[] = [];
    const fkMap: Map<number, { column: string; property: string } | null> = new Map();

    ownerRecords.forEach((owner, i) => {
      const fkInfo = this.extractManyToOneFk(ownerMeta, rel, owner);
      fkMap.set(i, fkInfo);
      if (fkInfo && owner[fkInfo.property] !== undefined && owner[fkInfo.property] !== null) {
        fkValues.push(owner[fkInfo.property]);
      }
    });
    const uniqueFks = Array.from(new Set(fkValues));
    if (uniqueFks.length === 0) {
      ownerRecords.forEach((_, i) => this.setRelation(ownerRecords[i], rel.propertyKey, null));
      return;
    }

    const targetPkCol = targetMeta.columns.get(targetMeta.primaryKeys[0])!.columnName;
    const targetQb = QueryBuilder.forEntity(this.targetClass(rel.targetEntity)).alias('t');
    targetQb.whereIn(`t.${targetPkCol}`, uniqueFks);
    const built = targetQb.buildSelect();
    const rows = await context.driver.query<DbRow>(built.sql, built.params);
    const targets = ResultMapper.mapRows(this.targetClass(rel.targetEntity), rows, {
      identityMap: context.identityMap,
    });

    const targetPkProp = targetMeta.primaryKeys[0];
    const targetMap = new Map<any, any>();
    for (const t of targets) {
      targetMap.set((t as any)[targetPkProp], t);
    }

    ownerRecords.forEach((owner, i) => {
      const fkInfo = fkMap.get(i);
      if (!fkInfo) {
        this.setRelation(owner, rel.propertyKey, null);
        return;
      }
      const fkVal = owner[fkInfo.property];
      const val = targetMap.get(fkVal) ?? null;
      this.setRelation(owner, rel.propertyKey, val);
    });
  }

  private static async loadOneToMany<T extends object>(
    entities: T[],
    ownerMeta: EntityMetadata,
    rel: RelationMetadata,
    inverseMeta: EntityMetadata,
    context: BatchLoadContext
  ): Promise<void> {
    const ownerRecords = entities as Array<Record<string, any>>;
    const ownerPkProp = ownerMeta.primaryKeys[0];
    const ownerPks: any[] = ownerRecords.map((o) => o[ownerPkProp]).filter(
      (v) => v !== undefined && v !== null
    );
    const uniquePks = Array.from(new Set(ownerPks));
    if (uniquePks.length === 0) {
      ownerRecords.forEach((_, i) => this.setRelation(ownerRecords[i], rel.propertyKey, []));
      return;
    }

    const fkColumn = this.resolveOneToManyFkColumn(rel, ownerMeta, inverseMeta);
    const inverseQb = QueryBuilder.forEntity(inverseMeta.target as EntityClass).alias('t');
    inverseQb.whereIn(`t.${fkColumn}`, uniquePks);
    const built = inverseQb.buildSelect();
    const rows = await context.driver.query<DbRow>(built.sql, built.params);
    const inverseItems = ResultMapper.mapRows(inverseMeta.target as EntityClass, rows, {
      identityMap: context.identityMap,
    });

    const fkProp = this.resolveInverseFkProperty(inverseMeta, fkColumn);
    const grouped = new Map<any, any[]>();
    for (const item of inverseItems) {
      const fkVal = (item as any)[fkProp];
      if (!grouped.has(fkVal)) grouped.set(fkVal, []);
      grouped.get(fkVal)!.push(item);
    }

    ownerRecords.forEach((owner) => {
      const pk = owner[ownerPkProp];
      this.setRelation(owner, rel.propertyKey, grouped.get(pk) ?? []);
    });
  }

  private static async loadManyToMany<T extends object>(
    entities: T[],
    ownerMeta: EntityMetadata,
    rel: RelationMetadata,
    targetMeta: EntityMetadata,
    context: BatchLoadContext
  ): Promise<void> {
    const ownerRecords = entities as Array<Record<string, any>>;
    const ownerPkProp = ownerMeta.primaryKeys[0];
    const ownerPks: any[] = ownerRecords.map((o) => o[ownerPkProp]).filter(
      (v) => v !== undefined && v !== null
    );
    const uniqueOwnerPks = Array.from(new Set(ownerPks));
    if (uniqueOwnerPks.length === 0) {
      ownerRecords.forEach((_, i) => this.setRelation(ownerRecords[i], rel.propertyKey, []));
      return;
    }

    const joinTable =
      rel.joinTable || this.getDefaultJoinTableName(ownerMeta, targetMeta);
    const joinColumn =
      rel.joinColumn || ownerMeta.tableName.replace(/s$/, '') + '_id';
    const inverseJoinColumn =
      rel.inverseJoinColumn || targetMeta.tableName.replace(/s$/, '') + '_id';
    const targetPkCol = targetMeta.columns.get(targetMeta.primaryKeys[0])!.columnName;

    const placeholders = uniqueOwnerPks.map((_, i) => `$${i + 1}`).join(', ');
    const jtSql = `SELECT ${joinColumn}, ${inverseJoinColumn} FROM ${joinTable} WHERE ${joinColumn} IN (${placeholders})`;
    const jtRows = await context.driver.query<DbRow>(jtSql, uniqueOwnerPks);
    if (jtRows.length === 0) {
      ownerRecords.forEach((_, i) => this.setRelation(ownerRecords[i], rel.propertyKey, []));
      return;
    }
    const seenPairs = new Set<string>();
    const uniqueJtRows: DbRow[] = [];
    for (const row of jtRows) {
      const key = `${row[joinColumn]}::${row[inverseJoinColumn]}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        uniqueJtRows.push(row);
      }
    }

    const targetFks = Array.from(new Set(uniqueJtRows.map((r) => r[inverseJoinColumn])));
    const targetQb = QueryBuilder.forEntity(targetMeta.target as EntityClass).alias('t');
    targetQb.whereIn(`t.${targetPkCol}`, targetFks);
    const targetBuilt = targetQb.buildSelect();
    const targetRows = await context.driver.query<DbRow>(targetBuilt.sql, targetBuilt.params);
    const targets = ResultMapper.mapRows(targetMeta.target as EntityClass, targetRows, {
      identityMap: context.identityMap,
    });

    const targetPkProp = targetMeta.primaryKeys[0];
    const targetMap = new Map<any, any>();
    for (const t of targets) {
      targetMap.set((t as any)[targetPkProp], t);
    }

    const ownerToTargets = new Map<any, any[]>();
    for (const row of uniqueJtRows) {
      const ownerFk = row[joinColumn];
      const targetFk = row[inverseJoinColumn];
      const t = targetMap.get(targetFk);
      if (!t) continue;
      if (!ownerToTargets.has(ownerFk)) ownerToTargets.set(ownerFk, []);
      ownerToTargets.get(ownerFk)!.push(t);
    }

    ownerRecords.forEach((owner) => {
      const pk = owner[ownerPkProp];
      this.setRelation(owner, rel.propertyKey, ownerToTargets.get(pk) ?? []);
    });
  }

  private static setRelation(entity: Record<string, any>, propertyKey: string, value: any): void {
    Object.defineProperty(entity, propertyKey, {
      get() {
        return value;
      },
      set(v: any) {
        Object.defineProperty(entity, propertyKey, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
      configurable: true,
      enumerable: true,
    });
  }

  private static extractManyToOneFk(
    ownerMeta: EntityMetadata,
    relation: RelationMetadata,
    ownerObj: Record<string, any>
  ): { column: string; property: string } | null {
    if (relation.foreignKey) {
      const col = ownerMeta.columns.get(relation.foreignKey);
      if (col && ownerObj[relation.foreignKey] !== undefined) {
        return { column: col.columnName, property: relation.foreignKey };
      }
      for (const [propKey, c] of ownerMeta.columns.entries()) {
        if (c.columnName === relation.foreignKey) {
          return { column: c.columnName, property: propKey };
        }
      }
    }
    const targetName = relation.propertyKey;
    const candidateProp = targetName + 'Id';
    if (ownerMeta.columns.has(candidateProp)) {
      return { column: ownerMeta.columns.get(candidateProp)!.columnName, property: candidateProp };
    }
    const candidateCol = metadataStore.snakeCase(targetName) + '_id';
    for (const [propKey, col] of ownerMeta.columns.entries()) {
      if (col.columnName === candidateCol) {
        return { column: candidateCol, property: propKey };
      }
    }
    for (const [propKey, col] of ownerMeta.columns.entries()) {
      if (col.columnName.endsWith('_id')) {
        return { column: col.columnName, property: propKey };
      }
    }
    return null;
  }

  private static resolveOneToManyFkColumn(
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
        if (col.columnName === candidateCol) return col.columnName;
      }
      for (const [, col] of inverseMeta.columns.entries()) {
        if (col.columnName.endsWith('_id')) return col.columnName;
      }
    }
    const singular = ownerMeta.tableName.replace(/s$/, '');
    const candidateCol = singular + '_id';
    for (const [, col] of inverseMeta.columns.entries()) {
      if (col.columnName === candidateCol) return col.columnName;
    }
    for (const [, col] of inverseMeta.columns.entries()) {
      if (col.columnName.endsWith('_id')) return col.columnName;
    }
    return candidateCol;
  }

  private static resolveInverseFkProperty(inverseMeta: EntityMetadata, fkColumn: string): string {
    for (const [propKey, col] of inverseMeta.columns.entries()) {
      if (col.columnName === fkColumn) return propKey;
    }
    return fkColumn;
  }

  private static targetClass(fn: () => Function): EntityClass {
    return fn() as EntityClass;
  }

  private static getDefaultJoinTableName(
    ownerMeta: EntityMetadata,
    targetMeta: EntityMetadata
  ): string {
    const names = [ownerMeta.tableName, targetMeta.tableName].sort();
    return names.join('_');
  }
}
