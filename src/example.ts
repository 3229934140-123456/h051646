import 'reflect-metadata';
import {
  Entity,
  Column,
  PrimaryKey,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinTable,
  metadataStore,
  QueryBuilder,
  UnitOfWork,
  MemoryDbDriver,
  nPlusOneDetector,
  Repository,
  ResultMapper,
} from './index';

@Entity({ table: 'departments' })
class Department {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  location!: string;

  @OneToMany(() => Employee, { mappedBy: 'department', lazy: true })
  employees!: Employee[];
}

@Entity({ table: 'employees' })
class Employee {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column()
  salary!: number;

  @Column({ name: 'hire_date' })
  hireDate!: Date;

  @Column({ name: 'department_id' })
  departmentId!: number;

  @ManyToOne(() => Department, { lazy: true })
  department!: Department;

  @ManyToMany(() => Project, { lazy: true })
  @JoinTable('employee_projects')
  projects!: Project[];
}

@Entity({ table: 'projects' })
class Project {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  budget!: number;

  @ManyToMany(() => Employee, { lazy: true })
  @JoinTable('employee_projects')
  employees!: Employee[];
}

async function main() {
  console.log('========== Mini ORM Framework Demo ==========\n');

  const driver = new MemoryDbDriver();
  const uow = new UnitOfWork(driver, { enableLazyLoading: true });

  driver.createTable('departments');
  driver.createTable('employees');
  driver.createTable('projects');
  driver.createTable('employee_projects');

  driver.insertData('departments', [
    { name: 'Engineering', location: 'Building A' },
    { name: 'Marketing', location: 'Building B' },
    { name: 'HR', location: 'Building C' },
  ]);

  driver.insertData('employees', [
    { name: 'Alice', email: 'alice@example.com', salary: 80000, hire_date: '2022-01-15T00:00:00.000Z', department_id: 1 },
    { name: 'Bob', email: 'bob@example.com', salary: 75000, hire_date: '2022-03-20T00:00:00.000Z', department_id: 1 },
    { name: 'Charlie', email: 'charlie@example.com', salary: 70000, hire_date: '2023-05-10T00:00:00.000Z', department_id: 2 },
  ]);

  driver.insertData('projects', [
    { name: 'Project Alpha', budget: 100000 },
    { name: 'Project Beta', budget: 150000 },
  ]);

  driver.insertData('employee_projects', [
    { employee_id: 1, project_id: 1 },
    { employee_id: 1, project_id: 2 },
    { employee_id: 2, project_id: 1 },
    { employee_id: 3, project_id: 2 },
  ]);

  console.log('--- 1. Entity Metadata Mapping ---');
  const deptMeta = metadataStore.getEntityMetadata(Department);
  console.log(`Department table: ${deptMeta?.tableName}`);
  console.log(`Department columns: ${Array.from(deptMeta!.columns.keys()).join(', ')}`);
  console.log(`Department relations: ${Array.from(deptMeta!.relations.keys()).join(', ')}\n`);

  console.log('--- 2. Query Builder - Parameterized SQL ---');
  const qb = QueryBuilder.forEntity(Employee)
    .alias('e')
    .select('e.id', 'e.name', 'e.salary')
    .where('e.salary', '>', 70000)
    .andWhere('e.department_id', '=', 1)
    .orderBy('e.salary', 'DESC')
    .limit(10);
  const built = qb.buildSelect();
  console.log('Generated SQL:', built.sql);
  console.log('Parameters:', built.params, '\n');

  console.log('--- 3. Simple Query & Row-to-Object Mapping ---');
  const employees = await uow.findAll(Employee);
  console.log(`Found ${employees.length} employees:`);
  for (const emp of employees) {
    console.log(`  - ${emp.name} (${emp.email}), salary: $${emp.salary}, hired: ${emp.hireDate?.toISOString().slice(0, 10)}`);
  }
  console.log();

  console.log('--- 4. Identity Map - Same Row = Same Object ---');
  const emp1 = await uow.findById(Employee, 1);
  const emp1Again = await uow.findById(Employee, 1);
  console.log(`emp1 === emp1Again: ${emp1 === emp1Again} (should be true)`);
  console.log(`Identity map size: ${uow.getIdentityMap().size()}\n`);

  console.log('--- 5. Lazy Loading (N+1 Detector Enabled) ---');
  nPlusOneDetector.enable();
  driver.setNPlusOneDetection(true, 3);
  driver.clearQueryLog();

  const allEmployees = await uow.findAll(Employee);
  for (const emp of allEmployees) {
    const deptPromise = (emp as any).department as Promise<Department>;
    if (deptPromise && typeof deptPromise.then === 'function') {
      const dept = await deptPromise;
      console.log(`  ${emp.name} works in ${dept?.name || 'unknown'}`);
    }
  }
  console.log(`Queries executed: ${driver.getQueryLog().length}`);
  console.log('N+1 warnings:', nPlusOneDetector.getWarnings().length, '\n');

  nPlusOneDetector.disable();
  nPlusOneDetector.clear();
  driver.setNPlusOneDetection(false);

  console.log('--- 6. Eager Loading (Single JOIN Query) ---');
  driver.clearQueryLog();
  uow.clear();
  const employeesWithDept = await uow.findWithRelations(Employee, ['department']);
  console.log(`Found ${employeesWithDept.length} employees with eager loading:`);
  for (const emp of employeesWithDept) {
    const dept = (emp as any).department as Department;
    console.log(`  - ${emp.name} -> ${dept?.name || 'N/A'} (${dept?.location || ''})`);
  }
  console.log(`Queries executed: ${driver.getQueryLog().length} (should be 1)\n`);

  console.log('--- 7. Eager Loading - One-to-Many Collection ---');
  driver.clearQueryLog();
  uow.clear();
  const deptsWithEmployees = await uow.findWithRelations(Department, ['employees']);
  for (const dept of deptsWithEmployees) {
    const empsVal = (dept as any).employees;
    const emps: Employee[] = Array.isArray(empsVal) ? empsVal : [];
    console.log(`  ${dept.name}: ${emps.length} employees`);
    for (const e of emps) {
      console.log(`    - ${e.name}`);
    }
  }
  console.log(`Queries executed: ${driver.getQueryLog().length}\n`);

  console.log('--- 8. Unit of Work - Insert New Entity ---');
  uow.clear();
  const newDept = new Department();
  newDept.name = 'Finance';
  newDept.location = 'Building D';
  await uow.save(newDept);
  console.log(`New department ID: ${newDept.id} (auto-generated)`);
  console.log(`Inserted row count: ${(await uow.getExecutedQueries().slice(-1)[0]) ? '1' : '0'}\n`);

  console.log('--- 9. Unit of Work - Change Tracking & Update ---');
  uow.clear();
  const empToUpdate = await uow.findById(Employee, 1);
  if (empToUpdate) {
    console.log(`Before update: ${empToUpdate.name} salary = $${empToUpdate.salary}`);
    empToUpdate.salary = 90000;
    const tracker = uow.getChangeTracker();
    const entry = tracker.getEntry(empToUpdate);
    console.log(`Entity state after modification: ${tracker.getEntityState(empToUpdate)}`);
    console.log(`Changed columns: ${tracker.getChangedColumns(entry!).join(', ')}`);
    await uow.commit();

    uow.clear();
    const updated = await uow.findById(Employee, 1);
    console.log(`After update: ${updated?.name} salary = $${updated?.salary}\n`);
  }

  console.log('--- 10. Unit of Work - Delete Entity ---');
  uow.clear();
  const empToDelete = await uow.findById(Employee, 3);
  if (empToDelete) {
    await uow.remove(empToDelete);
    uow.clear();
    const deleted = await uow.findById(Employee, 3);
    console.log(`Deleted employee exists: ${deleted !== null} (should be false)\n`);
  }

  console.log('--- 11. Repository Pattern ---');
  uow.clear();
  const empRepo = new Repository(Employee, uow);
  const highEarners = await empRepo.findWhere((qb) =>
    qb.where('salary', '>', 75000).orderBy('salary', 'DESC')
  );
  console.log(`High earners (salary > $75,000):`);
  for (const e of highEarners) {
    console.log(`  - ${e.name}: $${e.salary}`);
  }
  const count = await empRepo.count();
  console.log(`Total employees count: ${count}\n`);

  console.log('--- 12. Batch Operations - Dependency-Ordered Commit ---');
  uow.clear();
  const batchDept = new Department();
  batchDept.name = 'R&D';
  batchDept.location = 'Innovation Lab';
  uow.registerNew(batchDept);

  const batchEmp1 = new Employee();
  batchEmp1.name = 'Dave';
  batchEmp1.email = 'dave@example.com';
  batchEmp1.salary = 95000;
  batchEmp1.hireDate = new Date();
  batchEmp1.departmentId = batchDept.id;
  uow.registerNew(batchEmp1);

  const batchEmp2 = new Employee();
  batchEmp2.name = 'Eve';
  batchEmp2.email = 'eve@example.com';
  batchEmp2.salary = 85000;
  batchEmp2.hireDate = new Date();
  batchEmp2.departmentId = batchDept.id;
  uow.registerNew(batchEmp2);

  const batchResult = await uow.commit();
  console.log(`Batch insert result:`);
  console.log(`  Inserted: ${batchResult.inserted}`);
  console.log(`  Department ID: ${batchDept.id}`);
  console.log(`  Employee 1 ID: ${batchEmp1.id}`);
  console.log(`  Employee 2 ID: ${batchEmp2.id}`);
  console.log(`  Department was inserted first (has lower ID): ${batchDept.id < batchEmp1.id}\n`);

  console.log('--- 13. Complex Query Builder ---');
  const complexQb = QueryBuilder.forEntity(Employee)
    .alias('e')
    .select(
      { expression: 'COUNT(*)', alias: 'employee_count' },
      { expression: 'AVG(e.salary)', alias: 'avg_salary' },
      'e.department_id'
    )
    .whereBetween('e.salary', 50000, 100000)
    .andWhereIn('e.department_id', [1, 2])
    .groupBy('e.department_id')
    .orderBy('employee_count', 'DESC');

  const complexBuilt = complexQb.buildSelect();
  console.log('Complex SQL:');
  console.log('  ', complexBuilt.sql);
  console.log('  Params:', complexBuilt.params);

  console.log('\n========== All Demos Complete ==========');
}

main().catch((err) => {
  console.error('Demo error:', err);
  process.exit(1);
});
