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

async function seedDemo(uow: UnitOfWork, driver: MemoryDbDriver) {
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
    { name: 'Alice Johnson', email: 'alice@example.com', salary: 80000, hire_date: '2022-01-15T00:00:00.000Z', department_id: 1 },
    { name: 'Bob Smith', email: 'bob@example.com', salary: 75000, hire_date: '2022-03-20T00:00:00.000Z', department_id: 1 },
    { name: 'Charlie Brown', email: 'charlie@example.com', salary: 70000, hire_date: '2023-05-10T00:00:00.000Z', department_id: 2 },
    { name: 'Diana Prince', email: 'diana@example.com', salary: 88000, hire_date: '2021-11-01T00:00:00.000Z', department_id: 1 },
    { name: 'Eve Adams', email: 'eve@example.com', salary: 65000, hire_date: '2024-02-15T00:00:00.000Z', department_id: 3 },
  ]);

  driver.insertData('projects', [
    { name: 'Project Alpha', budget: 100000 },
    { name: 'Project Beta', budget: 150000 },
    { name: 'Project Gamma', budget: 200000 },
  ]);

  driver.insertData('employee_projects', [
    { employee_id: 1, project_id: 1 },
    { employee_id: 1, project_id: 2 },
    { employee_id: 2, project_id: 1 },
    { employee_id: 3, project_id: 2 },
    { employee_id: 4, project_id: 2 },
    { employee_id: 4, project_id: 3 },
  ]);
}

async function main() {
  console.log('========== Mini ORM Framework Demo ==========\n');

  const driver = new MemoryDbDriver();
  const uow = new UnitOfWork(driver, { enableLazyLoading: true });
  await seedDemo(uow, driver);

  // -------- Section 1: Entity Metadata --------
  console.log('--- 1. Entity Metadata Mapping ---');
  const deptMeta = metadataStore.getEntityMetadata(Department);
  console.log(`Department table: ${deptMeta?.tableName}`);
  console.log(`Department columns: ${Array.from(deptMeta!.columns.keys()).join(', ')}`);
  console.log(`Department relations: ${Array.from(deptMeta!.relations.keys()).join(', ')}\n`);

  // -------- Section 2: Nested WHERE Conditions --------
  console.log('--- 2. Query Builder: Nested WHERE Conditions ---');
  const complexQb = QueryBuilder.forEntity(Employee).alias('e')
    .select('e.id', 'e.name', 'e.salary', 'e.department_id')
    .where('e.salary', '>', 65000)
    .andGroup((g) =>
      g.whereIn('e.department_id', [1, 3]).orWhereLike('e.name', '%Alice%')
    )
    .orderBy('e.salary', 'DESC');
  const built = complexQb.buildSelect();
  console.log('Generated SQL:');
  console.log('  ', built.sql);
  console.log('Parameters:', built.params);

  driver.clearQueryLog();
  const qbRows = await driver.query<any>(built.sql, built.params);
  console.log(`\nResult (salary > 65000 AND (dept_id IN (1,3) OR name LIKE '%Alice%')):`);
  for (const row of qbRows) {
    console.log(`  - ${row.name}: $${row.salary} (dept_id=${row.department_id})`);
  }
  console.log(`Expected: Diana Prince, Alice Johnson, Bob Smith (3 people - Eve=65000 excluded by >65000, Charlie=Marketing excluded by IN(1,3) AND no LIKE match)`);
  console.log(`Queries executed: ${driver.getQueryLog().length}\n`);

  // -------- Section 3: Lazy Loading (N+1 baseline) --------
  console.log('--- 3. Lazy Loading Baseline (N+1 behavior) ---');
  uow.clear();
  driver.clearQueryLog();
  nPlusOneDetector.enable();
  driver.setNPlusOneDetection(true, 4);

  const empsLazy = await uow.findAll(Employee);
  console.log(`Loaded ${empsLazy.length} employees (1 query)`);
  for (const emp of empsLazy) {
    await (emp as any).department;
    await (emp as any).projects;
  }
  console.log(`Queries executed after lazy-loading dept + projects for each: ${driver.getQueryLog().length}`);
  console.log(`Expected ~11 queries (1 findAll + 5*2 lazy loads) - this is the N+1 baseline\n`);
  nPlusOneDetector.disable();
  nPlusOneDetector.clear();
  driver.setNPlusOneDetection(false);

  // -------- Section 4: Batch Preloading --------
  console.log('--- 4. Batch Preloading (Fix N+1) ---');
  uow.clear();
  driver.clearQueryLog();

  const empsBatch = await uow.findAll(Employee);
  console.log(`Loaded ${empsBatch.length} employees (1 query)`);
  const afterFindAll = driver.getQueryLog().length;
  await uow.loadRelations(empsBatch, ['department', 'projects']);
  console.log(`After batch loading dept + projects: ${driver.getQueryLog().length} queries total`);
  console.log(`Additional queries for batch: ${driver.getQueryLog().length - afterFindAll}`);
  console.log(`Expected: +5 queries max (1 dept IN query + 2 queries per M2M IN (jt + targets) - 4 total)\n`);

  console.log('Batch-loaded data verification:');
  for (const emp of empsBatch) {
    const deptName = (emp as any).department?.name ?? '(no dept)';
    const projectNames = (emp as any).projects?.map((p: any) => p.name).join(', ') || '(no projects)';
    console.log(`  ${emp.name}: [${deptName}] -> [${projectNames}]`);
  }

  // -------- Section 5: Transaction (Commit success) --------
  console.log('\n--- 5. UoW Transaction: Successful Batch Insert ---');
  uow.clear();
  driver.clearQueryLog();

  const beforeCount = (await uow.findAll(Employee)).length;
  console.log(`Employees before: ${beforeCount}`);

  const txDept = new Department();
  txDept.name = 'Finance';
  txDept.location = 'Building D';
  uow.registerNew(txDept);

  const txEmp1 = new Employee();
  txEmp1.name = 'Frank Castle';
  txEmp1.email = 'frank@example.com';
  txEmp1.salary = 92000;
  txEmp1.hireDate = new Date();
  txEmp1.departmentId = txDept.id;
  uow.registerNew(txEmp1);

  const txEmp2 = new Employee();
  txEmp2.name = 'Grace Hopper';
  txEmp2.email = 'grace@example.com';
  txEmp2.salary = 110000;
  txEmp2.hireDate = new Date();
  txEmp2.departmentId = txDept.id;
  uow.registerNew(txEmp2);

  try {
    const txResult = await uow.commit();
    console.log(`Transaction success: inserted ${txResult.inserted} (1 dept + 2 employees)`);
    uow.clear();
    const afterCount = (await uow.findAll(Employee)).length;
    console.log(`Employees after: ${afterCount} (expected: ${beforeCount + 2})`);
  } catch (err: any) {
    console.log(`Unexpected error: ${err.message}`);
  }

  // -------- Section 6: Transaction (Rollback on failure) --------
  console.log('\n--- 6. UoW Transaction: Failure & Rollback ---');
  uow.clear();
  driver.clearQueryLog();

  const beforeRollback = (await uow.findAll(Department)).length;
  console.log(`Departments before: ${beforeRollback}`);

  const goodDept = new Department();
  goodDept.name = 'Sales';
  goodDept.location = 'Building E';
  uow.registerNew(goodDept);

  const goodEmp = new Employee();
  goodEmp.name = 'Hank Pym';
  goodEmp.email = 'hank@example.com';
  goodEmp.salary = 98000;
  goodEmp.hireDate = new Date();
  goodEmp.departmentId = goodDept.id;
  uow.registerNew(goodEmp);

  uow.failNextCommit(
    '[Demo] Simulated business rule violation: cannot add Sales department during demo (triggering rollback)'
  );

  try {
    await uow.commit();
    console.log('Unexpected: commit succeeded (should have failed)');
  } catch (err: any) {
    console.log(`Transaction failed as expected: ${err.message.slice(0, 90)}...`);
  }

  uow.clear();
  const afterRollback = (await uow.findAll(Department)).length;
  console.log(`Departments after failed tx: ${afterRollback}`);
  console.log(`Rollback check: Sales dept NOT in DB - ${afterRollback === beforeRollback ? 'PASS (goodDept rolled back)' : 'FAIL'}\n`);

  // -------- Section 7: Error: Missing Primary Key --------
  console.log('--- 7. Error Handling: Missing Primary Key ---');
  try {
    @Entity({ table: 'orphan_table' })
    class OrphanEntity {
      @Column()
      name!: string;
    }
    metadataStore.getEntityMetadataOrThrow(OrphanEntity);
    console.log('FAIL: Should have thrown\n');
  } catch (err: any) {
    console.log(`Got expected error: ${err.message}\n`);
  }

  // -------- Section 8: Error: Wrong Relation Name --------
  console.log('--- 8. Error Handling: Wrong Relation Name (Eager Load) ---');
  uow.clear();
  try {
    await uow.findWithRelations(Employee, ['does_not_exist']);
    console.log('FAIL: Should have thrown\n');
  } catch (err: any) {
    console.log(`Got expected error: ${err.message}\n`);
  }

  // -------- Section 9: Error: Wrong Relation Name (Batch Load) --------
  console.log('--- 9. Error Handling: Wrong Relation Name (Batch Load) ---');
  uow.clear();
  const someEmps = await uow.findAll(Employee);
  try {
    await uow.loadRelations(someEmps.slice(0, 2), ['wrong_relation']);
    console.log('FAIL: Should have thrown\n');
  } catch (err: any) {
    console.log(`Got expected error: ${err.message}\n`);
  }

  // -------- Section 10: Warning for Missing Table (JoinTable empty scenario) --------
  console.log('--- 10. Warning: Missing Table / Empty Join Table ---');
  uow.clear();
  driver.clearQueryLog();

  const testDriver = new MemoryDbDriver();
  const testUow = new UnitOfWork(testDriver, { enableLazyLoading: true });
  testDriver.createTable('employees');
  testDriver.insertData('employees', [{ name: 'Zoe', email: 'z@x.com', salary: 1, hire_date: '2024-01-01', department_id: 1 }]);

  const zoe = await testUow.findById(Employee, 1);
  const zoeProjects = await (zoe as any).projects;
  console.log(`Zoe.projects with missing join table: ${zoeProjects?.length ?? 'undefined'} items`);
  console.log(`Expected: console warning about missing 'employee_projects' table, then empty result\n`);

  // -------- Section 11: Full Relationship Verification --------
  console.log('--- 11. Relationship Correctness Recap ---');
  uow.clear();
  const finalEmps = await uow.findAll(Employee);
  await uow.loadRelations(finalEmps, ['department', 'projects']);
  const checkExpectations = [
    ['Alice Johnson', 'Engineering', 'Project Alpha, Project Beta'],
    ['Bob Smith', 'Engineering', 'Project Alpha'],
    ['Diana Prince', 'Engineering', 'Project Beta, Project Gamma'],
  ];
  for (const [name, deptExpected, projsExpected] of checkExpectations) {
    const emp = finalEmps.find((e) => e.name === name)!;
    const deptName = (emp as any).department?.name ?? '';
    const projNames = (emp as any).projects?.map((p: any) => p.name).sort().join(', ') || '';
    const ok = deptName === deptExpected && projNames === projsExpected;
    console.log(`  ${name}: [${deptName}] -> [${projNames}] ${ok ? '✅' : '❌ (expected [' + deptExpected + '] / [' + projsExpected + '])'}`);
  }

  console.log('\n========== All Demos Complete ==========');
}

main().catch((err) => {
  console.error('Demo error:', err);
  process.exit(1);
});
