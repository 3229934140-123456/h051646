import {
  metadataStore,
  EntityClass,
  EntityMetadata,
  RelationMetadata,
  DbRow,
} from '../mapping';
import { QueryBuilder } from '../query';
import { TypeConverter, IdentityMap, ResultMapper } from '../result';
import { DbDriver, applyLazyLoading, LazyLoadContext, EagerLoader, EagerLoadOptions } from '../loading';
import { ChangeTracker } from './change-tracker';
import { EntityState, EntityEntry, CommitResult, SqlStatement } from './types';

export interface UnitOfWorkOptions {
  enableLazyLoading?: boolean;
  trackChanges?: boolean;
}

export class UnitOfWork {
  private driver: DbDriver;
  private identityMap: IdentityMap;
  private changeTracker: ChangeTracker;
  private options: Required<UnitOfWorkOptions>;
  private executedQueries: Array<{ sql: string; params: any[] }> = [];

  constructor(driver: DbDriver, options: UnitOfWorkOptions = {}) {
    this.driver = driver;
    this.identityMap = new IdentityMap();
    this.changeTracker = new ChangeTracker();
    this.options = {
      enableLazyLoading: options.enableLazyLoading ?? true,
      trackChanges: options.trackChanges ?? true,
    };
  }

  getIdentityMap(): IdentityMap {
    return this.identityMap;
  }

  getChangeTracker(): ChangeTracker {
    return this.changeTracker;
  }

  getDriver(): DbDriver {
    return this.driver;
  }

  createQueryBuilder<T>(entityClass: EntityClass<T>): QueryBuilder<T> {
    return QueryBuilder.forEntity(entityClass);
  }

  async findById<T extends object>(entityClass: EntityClass<T>, id: any): Promise<T | null> {
    const meta = metadataStore.getEntityMetadata(entityClass);
    if (!meta) {
      return null;
    }
    const pkProp = meta.primaryKeys[0];
    const pkCol = meta.columns.get(pkProp)!.columnName;

    const idStr = String(id);
    const cached = this.identityMap.get(entityClass, idStr);
    if (cached) {
      this.postLoadProcess(cached, entityClass);
      return cached as T;
    }

    const qb = QueryBuilder.forEntity(entityClass).where(pkCol, '=', id);
    const built = qb.buildSelect();
    this.logQuery(built.sql, built.params);

    const rows = await this.driver.query<DbRow>(built.sql, built.params);
    if (rows.length === 0) return null;

    const entity = ResultMapper.mapRow(entityClass, rows[0], { identityMap: this.identityMap });
    this.registerManaged(entity, entityClass);
    this.postLoadProcess(entity, entityClass);
    return entity;
  }

  async findAll<T extends object>(entityClass: EntityClass<T>): Promise<T[]> {
    const qb = QueryBuilder.forEntity(entityClass);
    return this.executeQuery(entityClass, qb);
  }

  async findWhere<T extends object>(
    entityClass: EntityClass<T>,
    predicate: (qb: QueryBuilder<T>) => QueryBuilder<T>
  ): Promise<T[]> {
    const qb = predicate(QueryBuilder.forEntity(entityClass));
    return this.executeQuery(entityClass, qb);
  }

  async findWithRelations<T extends object>(
    entityClass: EntityClass<T>,
    relations: string[],
    predicate?: (qb: QueryBuilder<T>) => QueryBuilder<T>
  ): Promise<T[]> {
    const baseQb = predicate ? predicate(QueryBuilder.forEntity(entityClass).alias('root')) : undefined;
    const options: EagerLoadOptions = { relations };
    const results = await EagerLoader.executeEagerQuery(
      entityClass,
      this.driver,
      options,
      baseQb,
      this.identityMap
    );
    for (const entity of results) {
      this.registerManaged(entity, entityClass);
      this.postLoadProcess(entity, entityClass);
    }
    return results;
  }

  async executeQuery<T extends object>(entityClass: EntityClass<T>, qb: QueryBuilder<T>): Promise<T[]> {
    const built = qb.buildSelect();
    this.logQuery(built.sql, built.params);
    const rows = await this.driver.query<DbRow>(built.sql, built.params);
    const entities = ResultMapper.mapRows(entityClass, rows, { identityMap: this.identityMap });
    for (const entity of entities) {
      this.registerManaged(entity, entityClass);
      this.postLoadProcess(entity, entityClass);
    }
    return entities;
  }

  async count<T>(
    entityClass: EntityClass<T>,
    predicate?: (qb: QueryBuilder<T>) => QueryBuilder<T>
  ): Promise<number> {
    let qb = QueryBuilder.forEntity(entityClass);
    if (predicate) qb = predicate(qb);
    const built = qb.buildCount();
    this.logQuery(built.sql, built.params);
    const rows = await this.driver.query<DbRow>(built.sql, built.params);
    return Number(rows[0]?.count ?? 0);
  }

  registerNew<T>(entity: T, entityClass?: EntityClass<T>): void {
    const cls = entityClass || ((entity as any).constructor as EntityClass<T>);
    this.changeTracker.registerNew(entity, cls);
  }

  registerManaged<T>(entity: T, entityClass?: EntityClass<T>): void {
    const cls = entityClass || ((entity as any).constructor as EntityClass<T>);
    const meta = metadataStore.getEntityMetadata(cls);
    if (meta && meta.primaryKeys.length > 0) {
      const pk = meta.primaryKeys[0];
      const idVal = (entity as any)[pk];
      if (idVal != null) {
        const idStr = String(idVal);
        if (!this.identityMap.has(cls, idStr)) {
          this.identityMap.set(cls, idStr, entity);
        }
      }
    }
    const existing = this.changeTracker.getEntry(entity);
    if (!existing) {
      this.changeTracker.registerManaged(entity, cls);
    }
  }

  registerRemoved<T>(entity: T, entityClass?: EntityClass<T>): void {
    const cls = entityClass || ((entity as any).constructor as EntityClass<T>);
    this.changeTracker.registerRemoved(entity, cls);
  }

  async save<T>(entity: T, entityClass?: EntityClass<T>): Promise<T> {
    const cls = entityClass || ((entity as any).constructor as EntityClass<T>);
    const entry = this.changeTracker.getEntry(entity);

    if (!entry) {
      const meta = metadataStore.getEntityMetadata(cls);
      if (meta && meta.primaryKeys.length > 0) {
        const pk = meta.primaryKeys[0];
        const idVal = (entity as any)[pk];
        if (idVal != null) {
          this.changeTracker.registerManaged(entity, cls);
        } else {
          this.changeTracker.registerNew(entity, cls);
        }
      } else {
        this.changeTracker.registerNew(entity, cls);
      }
    }

    await this.commit();
    return entity;
  }

  async remove<T>(entity: T, entityClass?: EntityClass<T>): Promise<void> {
    this.registerRemoved(entity, entityClass);
    await this.commit();
  }

  async commit(): Promise<CommitResult> {
    this.changeTracker.detectChanges();

    const statements = this.buildSqlStatements();
    const sortedStatements = this.sortByDependency(statements);

    const result: CommitResult = {
      inserted: 0,
      updated: 0,
      deleted: 0,
      generatedIds: new Map(),
      executedQueries: [],
    };

    for (const stmt of sortedStatements) {
      this.logQuery(stmt.sql, stmt.params);
      result.executedQueries.push({ sql: stmt.sql, params: stmt.params });

      const execResult = await this.driver.execute(stmt.sql, stmt.params);

      switch (stmt.operation) {
        case 'insert':
          result.inserted += execResult.rowCount;
          if (execResult.rows.length > 0 && stmt.entity) {
            const meta = metadataStore.getEntityMetadata(stmt.entityClass);
            if (meta) {
              for (const pk of meta.primaryKeys) {
                const col = meta.columns.get(pk)!;
                const generated = execResult.rows[0][col.columnName];
                if (generated !== undefined && generated !== null) {
                  (stmt.entity as any)[pk] = generated;
                  if (!result.generatedIds.has(stmt.entityClass)) {
                    result.generatedIds.set(stmt.entityClass, new Map());
                  }
                  const idKey = meta.primaryKeys.length === 1
                    ? String(generated)
                    : meta.primaryKeys.map((p) => String(execResult.rows[0][meta.columns.get(p)!.columnName])).join('::');
                  result.generatedIds.get(stmt.entityClass)!.set(idKey, generated);
                }
              }
            }
          }
          break;
        case 'update':
          result.updated += execResult.rowCount;
          break;
        case 'delete':
          result.deleted += execResult.rowCount;
          break;
      }
    }

    for (const [cls, map] of result.generatedIds) {
      for (const [id, val] of map) {
        const entries = this.changeTracker.getAllByClass(cls);
        for (const entry of entries) {
          const meta = metadataStore.getEntityMetadata(cls);
          if (meta && meta.primaryKeys.length === 1) {
            const pk = meta.primaryKeys[0];
            if ((entry.entity as any)[pk] === val) {
              this.identityMap.set(cls, id, entry.entity);
            }
          }
        }
      }
    }

    this.changeTracker.acceptChanges();
    this.executedQueries.push(...result.executedQueries);

    return result;
  }

  getExecutedQueries(): Array<{ sql: string; params: any[] }> {
    return [...this.executedQueries];
  }

  clearExecutedQueries(): void {
    this.executedQueries = [];
  }

  clear(): void {
    this.changeTracker.clear();
    this.identityMap.clear();
    this.executedQueries = [];
  }

  private postLoadProcess<T extends object>(entity: T, entityClass: EntityClass<T>): void {
    if (this.options.enableLazyLoading) {
      const context: LazyLoadContext = {
        driver: this.driver,
        identityMap: this.identityMap,
      };
      applyLazyLoading(entity, entityClass, context);
    }
  }

  private buildSqlStatements(): SqlStatement[] {
    const statements: SqlStatement[] = [];
    const entries = this.changeTracker.getAllEntries();

    for (const entry of entries) {
      switch (entry.state) {
        case 'new':
          statements.push(this.buildInsertStatement(entry));
          break;
        case 'modified':
          if (this.changeTracker.hasChanges(entry)) {
            statements.push(this.buildUpdateStatement(entry));
          }
          break;
        case 'removed':
          statements.push(this.buildDeleteStatement(entry));
          break;
      }
    }

    return statements;
  }

  private buildInsertStatement(entry: EntityEntry): SqlStatement {
    const meta = metadataStore.getEntityMetadataOrThrow(entry.entityClass);
    const data = TypeConverter.entityToRowExcludingAutoIncrement(entry.entity, meta.columns as any);
    const qb = QueryBuilder.forEntity(entry.entityClass);
    const built = qb.buildInsert(data);

    const metaOf = metadataStore.getEntityMetadataOrThrow(entry.entityClass);
    let priority = 50;
    for (const rel of metaOf.relations.values()) {
      if (rel.type === 'many-to-one') priority -= 10;
      if (rel.type === 'one-to-many') priority += 10;
    }

    return {
      sql: built.sql,
      params: built.params,
      entityClass: entry.entityClass,
      entity: entry.entity,
      operation: 'insert',
      priority,
    };
  }

  private buildUpdateStatement(entry: EntityEntry): SqlStatement {
    const meta = metadataStore.getEntityMetadataOrThrow(entry.entityClass);
    const qb = QueryBuilder.forEntity(entry.entityClass);

    const changed = this.changeTracker.getChangedColumns(entry);
    const updateData: Record<string, any> = {};
    for (const prop of changed) {
      const col = meta.columns.get(prop);
      if (col && !col.isPrimaryKey) {
        updateData[prop] = (entry.entity as any)[prop];
      }
    }

    const pkProps = meta.primaryKeys;
    for (const pk of pkProps) {
      qb.where(meta.columns.get(pk)!.columnName, '=', (entry.entity as any)[pk]);
    }

    const built = qb.buildUpdate(updateData);
    return {
      sql: built.sql,
      params: built.params,
      entityClass: entry.entityClass,
      entity: entry.entity,
      operation: 'update',
      priority: 100,
    };
  }

  private buildDeleteStatement(entry: EntityEntry): SqlStatement {
    const meta = metadataStore.getEntityMetadataOrThrow(entry.entityClass);
    const qb = QueryBuilder.forEntity(entry.entityClass);

    const pkProps = meta.primaryKeys;
    for (const pk of pkProps) {
      qb.where(meta.columns.get(pk)!.columnName, '=', (entry.entity as any)[pk]);
    }

    const built = qb.buildDelete();

    const metaOf = metadataStore.getEntityMetadataOrThrow(entry.entityClass);
    let priority = 150;
    for (const rel of metaOf.relations.values()) {
      if (rel.type === 'many-to-one') priority += 10;
      if (rel.type === 'one-to-many') priority -= 10;
    }

    return {
      sql: built.sql,
      params: built.params,
      entityClass: entry.entityClass,
      entity: entry.entity,
      operation: 'delete',
      priority,
    };
  }

  private sortByDependency(statements: SqlStatement[]): SqlStatement[] {
    const inserts = statements.filter((s) => s.operation === 'insert');
    const updates = statements.filter((s) => s.operation === 'update');
    const deletes = statements.filter((s) => s.operation === 'delete');

    const sortedInserts = this.topologicalSortInserts(inserts);
    const sortedDeletes = this.topologicalSortDeletes(deletes);

    return [...sortedInserts, ...updates, ...sortedDeletes];
  }

  private topologicalSortInserts(statements: SqlStatement[]): SqlStatement[] {
    return [...statements].sort((a, b) => {
      const aDeps = this.countDependencies(a.entityClass, 'many-to-one');
      const bDeps = this.countDependencies(b.entityClass, 'many-to-one');
      return aDeps - bDeps || a.priority - b.priority;
    });
  }

  private topologicalSortDeletes(statements: SqlStatement[]): SqlStatement[] {
    return [...statements].sort((a, b) => {
      const aDeps = this.countDependencies(a.entityClass, 'one-to-many');
      const bDeps = this.countDependencies(b.entityClass, 'one-to-many');
      return bDeps - aDeps || a.priority - b.priority;
    });
  }

  private countDependencies(entityClass: EntityClass, relType: 'many-to-one' | 'one-to-many'): number {
    const meta = metadataStore.getEntityMetadata(entityClass);
    if (!meta) return 0;
    let count = 0;
    for (const rel of meta.relations.values()) {
      if (rel.type === relType) count++;
    }
    return count;
  }

  private logQuery(sql: string, params: any[]): void {
    this.executedQueries.push({ sql, params: [...params] });
  }
}
