import { EntityClass } from '../mapping';
import { QueryBuilder } from '../query';
import { UnitOfWork } from './unit-of-work';

export class Repository<T extends object> {
  private entityClass: EntityClass<T>;
  private uow: UnitOfWork;

  constructor(entityClass: EntityClass<T>, uow: UnitOfWork) {
    this.entityClass = entityClass;
    this.uow = uow;
  }

  async findById(id: any): Promise<T | null> {
    return this.uow.findById(this.entityClass, id);
  }

  async findAll(): Promise<T[]> {
    return this.uow.findAll(this.entityClass);
  }

  async findWhere(
    predicate: (qb: QueryBuilder<T>) => QueryBuilder<T>
  ): Promise<T[]> {
    return this.uow.findWhere(this.entityClass, predicate);
  }

  async findWithRelations(
    relations: string[],
    predicate?: (qb: QueryBuilder<T>) => QueryBuilder<T>
  ): Promise<T[]> {
    return this.uow.findWithRelations(this.entityClass, relations, predicate);
  }

  async count(
    predicate?: (qb: QueryBuilder<T>) => QueryBuilder<T>
  ): Promise<number> {
    return this.uow.count(this.entityClass, predicate);
  }

  async add(entity: T): Promise<void> {
    this.uow.registerNew(entity, this.entityClass);
  }

  async update(entity: T): Promise<void> {
    this.uow.registerManaged(entity, this.entityClass);
  }

  async remove(entity: T): Promise<void> {
    this.uow.registerRemoved(entity, this.entityClass);
  }

  async save(entity: T): Promise<T> {
    return this.uow.save(entity, this.entityClass);
  }

  createQueryBuilder(): QueryBuilder<T> {
    return this.uow.createQueryBuilder(this.entityClass);
  }
}
